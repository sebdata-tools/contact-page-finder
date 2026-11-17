// Unit tests on real pages saved in test/fixtures/ (captured 2026-11-14, trimmed; every address in them
// that is not a role address was replaced by a made-up one at @madeup-fixture.test). No network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import * as cheerio from 'cheerio';

import {
    InputError, MAX_EMAILS, NETWORKS, ROLE_LOCAL_PARTS, classifyEmail, cleanSocialUrl, decodeBody, decodeCfEmail, detectContactForm,
    emailSourceCandidates, findAddresses, guessUrls, isHtml, isRoleLocalPart, isStrongCandidate, normalizeInput, orderEmails, parsePage,
    parseWebsite, pickSocialProfiles, rankContactCandidates, redactEmails, sanitizeUrl, scoreLink, siteKey, sortAddresses,
} from '../src/lib.js';

const dir = new URL('./fixtures/', import.meta.url);
const fixture = (name) => fs.readFileSync(new URL(name, dir), 'utf8');
const SOURCES = JSON.parse(fixture('sources.json')); // fixture file -> the address it was saved from
const page = (name) => parsePage(fixture(name), SOURCES[name]);
const candidatesOf = (name) => rankContactCandidates(page(name).links, SOURCES[name]);
const form = (html) => detectContactForm(cheerio.load(html), html);
// Everything of a parsed page that main.js can put in a dataset row (the raw link list stays inside the Actor).
const output = (p, url) => ({ title: p.title, siteName: p.siteName, emails: p.emails, socials: pickSocialProfiles(p.socials), form: p.form, candidates: rankContactCandidates(p.links, url) });

// ---------------------------------------------------------------- input

test('parseWebsite: domains and URLs', () => {
    assert.deepEqual(parseWebsite(' Plausible.io '), { url: 'https://plausible.io/', host: 'plausible.io', source: 'Plausible.io' });
    assert.equal(parseWebsite('http://www.example.org/en/?a=1#top').url, 'http://www.example.org/en/?a=1');
    assert.equal(parseWebsite(''), null);
    for (const bad of ['not a url', 'localhost', 'http://127.0.0.1/', 'https://user:pw@site.com']) assert.throws(() => parseWebsite(bad), InputError, bad);
});

test('normalizeInput: defaults, duplicates removed, bad input rejected', () => {
    const input = normalizeInput({ websites: ['basecamp.com', 'https://basecamp.com/', 'plausible.io', '', { url: 'https://ghost.org' }] });
    assert.deepEqual(input.targets.map((t) => t.url), ['https://basecamp.com/', 'https://plausible.io/', 'https://ghost.org/']);
    assert.equal(input.maxPagesPerSite, 4);
    assert.equal(input.proxyConfiguration, null);
    assert.equal(normalizeInput({ websites: 'a.com\nb.com', maxPagesPerSite: 8 }).maxPagesPerSite, 8);
    assert.equal(normalizeInput({ websites: 'a.com\nb.com' }).targets.length, 2);
    for (const bad of [null, {}, { websites: [] }, { websites: [''] }, { websites: [3] }, { websites: ['a.com'], maxPagesPerSite: 0 },
        { websites: ['a.com'], maxPagesPerSite: 9 }, { websites: ['a.com'], maxPagesPerSite: 1.5 }, { websites: ['not a url'] }]) {
        assert.throws(() => normalizeInput(bad), InputError, JSON.stringify(bad));
    }
    assert.throws(() => normalizeInput({ websites: Array.from({ length: 1001 }, (_, i) => `site${i}.com`) }), /Too many/);
});

test('siteKey: the registrable domain by a simple rule', () => {
    assert.equal(siteKey('www.example.com'), 'example.com');
    assert.equal(siteKey('support.fastmail.com'), 'fastmail.com');
    assert.equal(siteKey('shop.example.co.uk'), 'example.co.uk');
    assert.equal(siteKey('example.de'), 'example.de');
});

test('sanitizeUrl and redactEmails: no address leaves through a URL or a title', () => {
    assert.equal(sanitizeUrl('https://site.com/contact?to=jane.roe%40site.com#form'), 'https://site.com/contact');
    assert.equal(sanitizeUrl('https://site.com/contact?lang=en#form'), 'https://site.com/contact?lang=en');
    assert.equal(sanitizeUrl('https://site.com/people/jane.roe@site.com'), null);
    assert.equal(sanitizeUrl('nonsense'), null);
    assert.equal(redactEmails('Jane Roe (jane.roe@site.com) | Studio'), 'Jane Roe () | Studio');
    assert.equal(redactEmails(null), null);
});

// ---------------------------------------------------------------- the allowlist rule

test('allowlist: role addresses are recognised', () => {
    for (const a of ['info@site.com', 'INFO@Site.COM', 'sales@site.co.uk', 'support@site.io', 'hello@site.app', 'press@site.com', 'kontakt@firma.de',
        'contacto@empresa.es', 'contatti@azienda.it', 'customer.service@site.com', 'customercare@site.com', 'privacy@site.com', 'webmaster@site.org',
        'presse@firma.de', 'bonjour@maison.fr', 'biuro@firma.pl', 'info@gmail.com']) {
        assert.equal(classifyEmail(a).kind, 'role', a);
    }
    assert.equal(classifyEmail(' Info@Site.com. ').address, 'info@site.com');
    assert.ok(isRoleLocalPart('Sales'));
    assert.ok(ROLE_LOCAL_PARTS.size > 200);
    for (const part of ROLE_LOCAL_PARTS) assert.match(part, /^[a-z][a-z0-9.-]*$/, part); // lower-case entries only: the lookup lower-cases the address
});

test('allowlist: anything that is not exactly a role name is never output (negative cases)', () => {
    const personal = ['john.smith@site.com', 'jsmith@site.com', 'j.smith@site.com', 'john@site.com', 'anna@firma.de', 'js@site.com', 'smith@site.com',
        'john_smith@site.com', 'dr.mueller@praxis-mueller.de', 'ceo@site.com', 'founder@site.com', 'owner@site.com', 'max@site.com', 'marie.dupont@maison.fr',
        'info.john@site.com', 'john.info@site.com', 'sales-john@site.com', 'info+john@site.com', 'infos2@site.com', 'salesteam.anna@site.com',
        'supportjohn@site.com', 'theinfo@site.com', 'k.nowak@firma.pl', 'john.smith@gmail.com', 'bakery.rosa@gmail.com', 'me@site.com', 'a@site.com'];
    for (const a of personal) {
        assert.equal(classifyEmail(a).kind, 'other', a);
        assert.equal(isRoleLocalPart(a.split('@')[0]), false, a);
    }
    const sorted = sortAddresses([...personal, 'info@site.com', 'Sales@site.com', 'info@site.com']);
    assert.deepEqual(sorted.role, ['info@site.com', 'sales@site.com']);
    assert.equal(sorted.otherHashes.length, personal.length);
    const json = JSON.stringify(sorted);
    for (const a of personal) {
        assert.ok(!json.includes(a), a);
        if (a.split('@')[0].length > 4) assert.ok(!json.includes(a.split('@')[0]), a); // not even the name part
    }
    for (const h of sorted.otherHashes) assert.match(h, /^[0-9a-f]{16}$/);
    assert.deepEqual(sortAddresses(['john.smith@site.com', 'JOHN.SMITH@site.com']).otherHashes.length, 1); // counted once
});

test('classifyEmail: image names, placeholders and tracking ids are dropped, not counted', () => {
    for (const a of ['logo@2x.png', 'hero-image@3x.webp', 'icon@2x.svg', 'bundle@1.2.js', 'user@example.com', 'info@example.org', 'name@domain.com',
        'you@yourdomain.com', '9f3c2a1b4d5e6f708192a3b4c5d6e7f8@o123.ingest.sentry.io', 'abc@sentry-next.wixpress.com', 'x@sentry.wixpress.com',
        'noreply@site.com', 'no-reply@site.com', 'yourname@site.com', 'john.doe@site.com', 'max.mustermann@firma.de', 'not-an-address', '@site.com',
        'info@site', 'info@site.c', 'a@b@c.com', 'info@-site.com', '12345@site.com']) {
        assert.equal(classifyEmail(a).kind, 'junk', a);
    }
    assert.deepEqual(sortAddresses(['logo@2x.png', 'user@example.com', 'noreply@site.com']), { role: [], otherHashes: [] });
});

test('findAddresses: plain text and the simple bracketed obfuscations', () => {
    assert.deepEqual(findAddresses('Write to info@site.com, or sales@site.co.uk.'), ['info@site.com', 'sales@site.co.uk']);
    assert.deepEqual(findAddresses('info [at] site [dot] com / presse(at)firma.de / kontakt (ät) firma (punkt) de / hello{at}site.io'),
        ['info@site.com', 'presse@firma.de', 'kontakt@firma.de', 'hello@site.io']);
    assert.deepEqual(findAddresses('Email:contact@raygunsite.comCall us'), ['contact@raygunsite.com']); // a word stuck to the address
    assert.deepEqual(findAddresses('meet us at the booth. No address here @ all'), []);
    assert.deepEqual(findAddresses(null), []);
});

test('decodeCfEmail: Cloudflare-protected addresses', () => {
    const encode = (text, key) => [key, ...[...text].map((c) => c.charCodeAt(0) ^ key)].map((n) => n.toString(16).padStart(2, '0')).join('');
    assert.equal(decodeCfEmail(encode('info@site.org', 0x42)), 'info@site.org');
    assert.equal(decodeCfEmail('zz'), null);
    assert.equal(decodeCfEmail(''), null);
    const html = `<html><body><a href="/cdn-cgi/l/email-protection#${encode('sales@shop.io', 7)}">[email&#160;protected]</a>
        <span data-cfemail="${encode('rosa.klein@shop.io', 9)}">[email&#160;protected]</span></body></html>`;
    assert.deepEqual(parsePage(html, 'https://shop.io/').emails, { role: ['sales@shop.io'], otherHashes: sortAddresses(['rosa.klein@shop.io']).otherHashes });
    // Real page: buttondown.com protects its address this way.
    assert.match(fixture('buttondown_home.html'), /email-protection#[0-9a-f]+/);
    assert.deepEqual(page('buttondown_home.html').emails.role, ['support@buttondown.com']);
});

test('orderEmails: own domain first, capped', () => {
    assert.deepEqual(orderEmails(['sales@other.com', 'support@site.com', 'info@mail.site.com', 'support@site.com'], 'www.site.com'),
        ['info@mail.site.com', 'support@site.com', 'sales@other.com']);
    assert.equal(orderEmails(Array.from({ length: 40 }, (_, i) => `info@site${i}.com`), 'x.com').length, MAX_EMAILS);
});

// ---------------------------------------------------------------- social profiles

test('cleanSocialUrl: profiles are cleaned', () => {
    const cases = {
        'https://www.linkedin.com/company/plausible-analytics/?trk=x': 'https://www.linkedin.com/company/plausible-analytics',
        'https://de.linkedin.com/company/Hetzner-Online': 'https://www.linkedin.com/company/hetzner-online',
        'https://www.linkedin.com/school/mit/': 'https://www.linkedin.com/school/mit',
        'https://linkedin.com/showcase/some-product/about/': 'https://www.linkedin.com/showcase/some-product',
        'https://twitter.com/PlausibleHQ?lang=en': 'https://x.com/PlausibleHQ',
        'https://x.com/@linear': 'https://x.com/linear',
        'http://www.facebook.com/kingarthurbaking/': 'https://www.facebook.com/kingarthurbaking',
        'https://m.facebook.com/pages/Some-Bakery/123456789': 'https://www.facebook.com/pages/Some-Bakery/123456789',
        'https://www.facebook.com/profile.php?id=100064000000000&ref=x': 'https://www.facebook.com/profile.php?id=100064000000000',
        'https://fb.com/StripeHQ': 'https://www.facebook.com/StripeHQ',
        'https://www.instagram.com/levainbakery/?hl=en': 'https://www.instagram.com/levainbakery',
        'https://www.youtube.com/@stripe/videos': 'https://www.youtube.com/@stripe',
        'https://www.youtube.com/channel/UCWiHttSGvOn4R6HxQ4AiEDA': 'https://www.youtube.com/channel/UCWiHttSGvOn4R6HxQ4AiEDA',
        'https://youtube.com/user/CityLightsBooks': 'https://www.youtube.com/user/CityLightsBooks',
        'https://www.youtube.com/KingArthurBakingCompany': 'https://www.youtube.com/KingArthurBakingCompany',
        'https://www.tiktok.com/@levainbakery?lang=en': 'https://www.tiktok.com/@levainbakery',
        'https://github.com/plausible/analytics': 'https://github.com/plausible',
    };
    for (const [href, want] of Object.entries(cases)) assert.equal(cleanSocialUrl(href)?.url, want, href);
    assert.equal(cleanSocialUrl('https://twitter.com/PlausibleHQ').network, 'twitter');
    assert.equal(cleanSocialUrl('https://x.com/linear').network, 'twitter');
});

test('cleanSocialUrl: share links, single posts and personal LinkedIn profiles are skipped', () => {
    for (const href of [
        'https://www.linkedin.com/in/jane-roe-12345/', 'https://linkedin.com/in/janeroe', 'https://www.linkedin.com/pub/jane-roe/1/2/3',
        'https://www.linkedin.com/shareArticle?mini=true&url=x', 'https://www.linkedin.com/sharing/share-offsite/?url=x', 'https://www.linkedin.com/company/',
        'https://twitter.com/intent/tweet?text=x', 'https://twitter.com/share?url=x', 'https://x.com/intent/follow?screen_name=a', 'https://twitter.com/home?status=x',
        'https://twitter.com/PlausibleHQ/status/123456', 'https://x.com/search?q=x', 'https://twitter.com/hashtag/baking',
        'https://www.facebook.com/sharer.php?u=x', 'https://www.facebook.com/sharer/sharer.php?u=x', 'https://www.facebook.com/share.php?u=x',
        'https://www.facebook.com/dialog/share?app_id=1', 'https://www.facebook.com/tr?id=1', 'https://www.facebook.com/plugins/like.php', 'https://www.facebook.com/',
        'https://www.instagram.com/p/Cabc123/', 'https://www.instagram.com/reel/Cabc/', 'https://www.instagram.com/explore/tags/x/', 'https://www.instagram.com/',
        'https://www.youtube.com/watch?v=abc', 'https://www.youtube.com/embed/abc', 'https://www.youtube.com/playlist?list=x', 'https://youtu.be/abc',
        'https://www.tiktok.com/@levainbakery/video/123', 'https://www.tiktok.com/share?url=x', 'https://www.tiktok.com/tag/x',
        'https://github.com/features', 'https://github.com/login', 'https://github.com/',
        'https://example.com/company/x', 'mailto:info@site.com', 'not a url',
    ]) assert.equal(cleanSocialUrl(href), null, href);
});

test('pickSocialProfiles: one per network, the most linked, all keys present', () => {
    const found = ['https://x.com/widgetmaker', 'https://x.com/acme', 'https://www.linkedin.com/company/acme', 'https://twitter.com/Acme']
        .map(cleanSocialUrl);
    const picked = pickSocialProfiles(found);
    assert.deepEqual(Object.keys(picked), NETWORKS);
    assert.equal(picked.twitter, 'https://x.com/acme'); // linked twice (case-insensitive) beats the one linked first
    assert.equal(picked.linkedin, 'https://www.linkedin.com/company/acme');
    assert.equal(picked.github, null);
    assert.deepEqual(pickSocialProfiles([]), { linkedin: null, twitter: null, facebook: null, instagram: null, youtube: null, tiktok: null, github: null });
});

// ---------------------------------------------------------------- contact links

test('scoreLink: paths and anchor texts in several languages', () => {
    const s = (href, text) => scoreLink(new URL(href), text);
    for (const [href, text] of [['https://a.com/contact', 'Contact'], ['https://a.com/contact-us/', ''], ['https://a.de/kontakt', 'Kontakt'], ['https://a.es/contacto', 'Contacto'],
        ['https://a.it/contatti', 'Contatti'], ['https://a.fr/nous-contacter', 'Nous contacter'], ['https://a.com/get-in-touch', 'Get in touch'], ['https://a.com/en/contact.html', ''],
        ['https://a.fr/page-12', 'Contactez-nous'], ['https://a.com/pages/hello', 'Contact us'], ['https://a.de/kontakt-c199446/', 'Kontakt'], ['https://a.com/contact/sales', 'Contact sales'],
        ['https://a.es/x', 'Contáctanos']]) {
        const got = s(href, text);
        assert.equal(got?.kind, 'contact', href);
        assert.ok(isStrongCandidate({ ...got, inPage: false }), `${href} should be a strong candidate (${got.score})`);
    }
    assert.equal(s('https://a.com/support', 'Support').kind, 'support');
    assert.equal(s('https://a.com/help', '').kind, 'support');
    assert.equal(s('https://a.com/about', 'About us').kind, 'about');
    assert.equal(s('https://a.de/impressum', 'Impressum').kind, 'notice');
    assert.ok(s('https://a.com/contact', 'Contact').score > s('https://a.com/support', 'Support').score);
    assert.ok(s('https://a.com/support', 'Support').score > s('https://a.com/about', 'About').score);
    // Not contact pages.
    assert.equal(s('https://a.com/pricing', 'Pricing'), null);
    assert.equal(s('https://a.de/kontaktgrill-elektrisch-a213301/', 'Kontaktgrill elektrisch'), null);
    assert.equal(s('https://a.com/blog/how-to-contact-support', 'How to contact support'), null);
    assert.equal(s('https://a.com/products/contact-lens-case', ''), null);
    assert.equal(isStrongCandidate({ ...s('https://a.com/about', 'About us'), inPage: false }), false);
});

test('rankContactCandidates on real homepages', () => {
    assert.deepEqual(candidatesOf('plausible_home.html')[0], { url: 'https://plausible.io/contact', score: 160, kind: 'contact', inPage: false });
    assert.deepEqual(candidatesOf('plausible_home.html').map((c) => c.kind), ['contact', 'notice', 'about']);

    const manufactum = candidatesOf('manufactum_home.html'); // German shop; also sells a "Kontaktgrill"
    assert.equal(manufactum[0].url, 'https://www.manufactum.de/kontakt-c199446/');
    assert.ok(isStrongCandidate(manufactum[0]));
    assert.ok(!manufactum.some((c) => /kontaktgrill/.test(c.url)));
    assert.ok(manufactum.some((c) => c.kind === 'notice' && /impressum/.test(c.url)));

    assert.equal(candidatesOf('hofpfisterei_home.html')[0].url, 'https://www.hofpfisterei.de/contact_us.php');

    const citylights = candidatesOf('citylights_home.html'); // no contact link at all: only a "Customer Support" link to the FAQ
    assert.deepEqual(citylights, [{ url: 'https://citylights.com/faq', score: 25, kind: 'support', inPage: false }]);
    assert.ok(!isStrongCandidate(citylights[0]));

    assert.deepEqual(candidatesOf('js_shell_elliottbay.html'), []); // a JavaScript app shell has no links
    assert.equal(candidatesOf('kingarthur_contact.html')[0].url, 'https://www.kingarthurbaking.com/contact-us'); // the shorter of two equal scores
});

test('rankContactCandidates: same site only, in-page sections, no files, no addresses in URLs', () => {
    const links = [
        { href: 'https://other-company.com/contact', text: 'Contact' },
        { href: 'https://help.site.com/contact', text: 'Contact support' },
        { href: 'https://www.site.com/files/contact.pdf', text: 'Contact' },
        { href: 'https://www.site.com/#contact', text: 'Contact' },
        { href: 'https://www.site.com/', text: 'Home' },
        { href: 'https://www.site.com/kontakt?ref=nav', text: 'Kontakt' },
        { href: 'https://www.site.com/contact?to=jane.roe@site.com', text: 'Write to Jane' },
        { href: 'https://www.site.com/about', text: 'About' },
    ];
    const got = rankContactCandidates(links, 'https://www.site.com/');
    assert.deepEqual(got.map((c) => c.url), ['https://help.site.com/contact', 'https://www.site.com/kontakt?ref=nav', 'https://www.site.com/contact',
        'https://www.site.com/#contact', 'https://www.site.com/about']);
    assert.deepEqual(got.find((c) => c.inPage), { url: 'https://www.site.com/#contact', score: 50, kind: 'contact', inPage: true });
    assert.ok(!JSON.stringify(got).includes('jane'));
    assert.deepEqual(rankContactCandidates([{ href: 'https://site.co.uk/contact', text: '' }], 'https://other.co.uk/'), []); // "co.uk" is not a shared site
});

test('emailSourceCandidates: legal notice first', () => {
    assert.deepEqual(emailSourceCandidates(candidatesOf('plausible_home.html')).map((c) => c.url),
        ['https://plausible.io/imprint', 'https://plausible.io/contact', 'https://plausible.io/about']);
});

test('guessUrls: the usual paths, the site language first', () => {
    assert.deepEqual(guessUrls('https://www.site.com/en/home', 'en-US'), ['https://www.site.com/contact', 'https://www.site.com/contact-us']);
    assert.deepEqual(guessUrls('https://firma.de/', 'de'), ['https://firma.de/kontakt', 'https://firma.de/contact']);
    assert.deepEqual(guessUrls('https://empresa.es/', 'es-ES'), ['https://empresa.es/contacto', 'https://empresa.es/contact']);
    assert.deepEqual(guessUrls('https://site.com/', null), ['https://site.com/contact', 'https://site.com/contact-us']);
});

// ---------------------------------------------------------------- forms

test('detectContactForm on real pages', () => {
    assert.equal(page('raygun_contact.html').form, 'html'); // Shopify contact form
    assert.equal(page('mcnally_contact.html').form, 'html');
    assert.equal(page('dallmayr_contact.html').form, 'html');
    assert.equal(page('buttondown_home.html').form, 'html'); // a contact form on the homepage itself
    assert.equal(page('rittersport_contact.html').form, 'embed'); // Paperform loaded by script
    assert.equal(page('kingarthur_contact.html').form, null); // only the footer newsletter form
    assert.equal(page('plausible_contact.html').form, null); // lists addresses, no form
    assert.equal(page('plausible_home.html').form, null);
    assert.equal(page('manufactum_home.html').form, null); // search and newsletter only
});

test('detectContactForm: search, login and newsletter forms do not count', () => {
    assert.equal(form('<form action="/search"><input type="text" name="q"><button>Go</button></form>'), null);
    assert.equal(form('<form role="search"><input name="query"><textarea name="x"></textarea></form>'), null);
    assert.equal(form('<form action="/login"><input type="email" name="email"><input type="password" name="pw"></form>'), null);
    assert.equal(form('<form class="newsletter"><input type="email" name="email"><input type="submit"></form>'), null);
    assert.equal(form('<form id="mc-embedded-subscribe-form"><input type="email" name="EMAIL"><input type="text" name="FNAME"><input type="text" name="LNAME"></form>'), null);
    assert.equal(form('<form><input type="email" name="email"><input type="hidden" name="t"><input type="checkbox" name="ok"></form>'), null);
    assert.equal(form('<form><textarea name="g-recaptcha-response"></textarea><input type="email" name="email"></form>'), null);
    assert.equal(form('<p>No form here</p>'), null);
    // These do.
    assert.equal(form('<form><input name="name"><input type="email" name="email"><textarea name="message"></textarea></form>'), 'html');
    assert.equal(form('<form><input name="your-name"><input name="your-email"><input name="your-subject"></form>'), 'html');
    assert.equal(form('<form class="demo-request"><input name="first"><input type="email" name="email"><input name="company"><select name="size"></select></form>'), 'html');
    assert.equal(form('<form><input name="Nachricht" placeholder="Ihre Nachricht"><input type="email" name="mail"></form>'), 'html');
    assert.equal(form('<div><script>hbspt.forms.create({portalId: "1", formId: "x"});</script></div>'), 'embed');
    assert.equal(form('<iframe src="https://docs.google.com/forms/d/e/abc/viewform?embedded=true"></iframe>'), 'embed');
    assert.equal(form('<iframe src="https://www.youtube.com/embed/abc"></iframe>'), null);
});

// ---------------------------------------------------------------- whole pages

test('parsePage: a SaaS homepage and its contact page', () => {
    const home = page('plausible_home.html');
    assert.equal(home.title, 'Plausible Analytics | Simple, privacy-friendly Google Analytics alternative');
    assert.equal(home.siteName, 'Plausible Analytics');
    assert.equal(home.lang, 'en');
    assert.equal(home.blocked, false);
    assert.equal(home.looksLikeContact, false);
    assert.deepEqual(home.emails, { role: [], otherHashes: [] });
    assert.deepEqual(pickSocialProfiles(home.socials), { linkedin: 'https://www.linkedin.com/company/plausible-analytics', twitter: 'https://x.com/PlausibleHQ',
        facebook: null, instagram: null, youtube: null, tiktok: null, github: 'https://github.com/plausible' });

    const contact = page('plausible_contact.html');
    assert.equal(contact.title, 'Contact | Plausible Analytics');
    assert.equal(contact.looksLikeContact, true);
    assert.deepEqual(contact.emails, { role: ['hello@plausible.io'], otherHashes: [] });
});

test('parsePage: contact pages with role addresses and with other addresses', () => {
    const raygun = page('raygun_contact.html');
    assert.deepEqual(raygun.emails.role, ['contact@raygunsite.com', 'wholesale@raygunsite.com']);
    assert.equal(raygun.emails.otherHashes.length, 1);
    assert.equal(pickSocialProfiles(raygun.socials).instagram, 'https://www.instagram.com/raygunshirts');

    const wedel = page('wedel_kontakt.html'); // Polish
    assert.equal(wedel.lang, 'pl');
    assert.equal(wedel.looksLikeContact, true);
    assert.deepEqual(wedel.emails.role, ['kontakt@wedel.pl', 'pr@wedel.pl', 'kontakt@wedelpijalnie.pl']);
    assert.equal(wedel.emails.otherHashes.length, 1);
    assert.deepEqual(pickSocialProfiles(wedel.socials), { linkedin: 'https://www.linkedin.com/company/lotte-wedel', twitter: null, facebook: 'https://www.facebook.com/czekolada',
        instagram: 'https://www.instagram.com/e.wedel', youtube: 'https://www.youtube.com/channel/UCWiHttSGvOn4R6HxQ4AiEDA', tiktok: null, github: null });

    const mcnally = page('mcnally_contact.html');
    assert.deepEqual([...mcnally.emails.role].sort(), ['donations@mcnallyjacksonbooks.com', 'events@mcnallyjackson.com', 'info@mcnallyjackson.com',
        'marketing@mcnallyjackson.com', 'partnerships@mcnallyjacksonbooks.com', 'pr@mcnallyjacksonbooks.com', 'rentals@mcnallyjacksonbooks.com']);
    assert.equal(mcnally.emails.otherHashes.length, 6);

    const kingarthur = page('kingarthur_contact.html');
    assert.deepEqual(kingarthur.emails.role, ['customercare@kingarthurbaking.com']);
    assert.equal(kingarthur.emails.otherHashes.length, 2);
    assert.deepEqual(pickSocialProfiles(kingarthur.socials), { linkedin: 'https://www.linkedin.com/company/kingarthurbakingcompany', twitter: null,
        facebook: 'https://www.facebook.com/kingarthurbaking', instagram: 'https://www.instagram.com/kingarthurbaking',
        youtube: 'https://www.youtube.com/KingArthurBakingCompany', tiktok: 'https://www.tiktok.com/@kingarthurbakingcompany', github: null });

    assert.deepEqual(page('manufactum_home.html').emails.role, ['info@manufactum.de']); // German homepage, address in the footer
    assert.equal(page('manufactum_home.html').lang, 'de');
});

test('parsePage: a bot-check page is recognised, a JavaScript shell reads as empty', () => {
    const blocked = page('blocked_strandbooks.html');
    assert.equal(blocked.title, 'Just a moment...');
    assert.equal(blocked.blocked, true);
    const shell = page('js_shell_elliottbay.html');
    assert.equal(shell.blocked, false);
    assert.equal(shell.links.length, 0);
    assert.equal(shell.looksLikeContact, false);
    // A real page that merely has such a title in a long text is not a block page.
    assert.equal(parsePage(`<html><head><title>Access denied</title></head><body>${'<p>Long article text about access rules.</p>'.repeat(200)}</body></html>`, 'https://a.com/').blocked, false);
    // A "not found" page answering 200 does not pass as a contact page.
    assert.equal(parsePage('<html><head><title>Page not found | Site</title></head><body><h1>404</h1><p>Contact us</p></body></html>', 'https://a.com/contact').looksLikeContact, false);
});

test('parsePage: mailto links, JSON-LD and text; personal addresses never appear in the result', () => {
    const html = `<html lang="de"><head><title>Studio Nord - anna.berg@studio-nord.de</title>
        <meta property="og:site_name" content="Studio Nord">
        <script type="application/ld+json">{"@type":"Organization","email":"mailto:office@studio-nord.de","sameAs":["https:\\/\\/www.instagram.com\\/studionord","https://www.linkedin.com/in/anna-berg"]}</script>
        <script>var x = "tracker@studio-nord.de"; var img = "logo@2x.png";</script></head>
        <body><img src="/img/logo@2x.png"><a href="mailto:Info@Studio-Nord.de?subject=Hallo%20Welt">Mail</a>
        <a href="mailto:anna.berg@studio-nord.de,presse@studio-nord.de">Anna Berg</a>
        <p>Vertrieb: vertrieb(at)studio-nord.de</p><p>Peter Holm: p.holm@studio-nord.de</p><p>Demo: name@example.com</p>
        <a href="https://www.linkedin.com/in/peter-holm/">Peter</a><a href="https://twitter.com/intent/tweet?text=hi">Share</a>
        <a href="tel:+49301234567">Call</a></body></html>`;
    const got = parsePage(html, 'https://studio-nord.de/');
    assert.deepEqual([...got.emails.role].sort(), ['info@studio-nord.de', 'office@studio-nord.de', 'presse@studio-nord.de', 'vertrieb@studio-nord.de']);
    assert.equal(got.emails.otherHashes.length, 2); // anna.berg and p.holm, each once; the script variable is not read
    assert.equal(got.title, 'Studio Nord -');
    assert.deepEqual(got.socials, [{ network: 'instagram', url: 'https://www.instagram.com/studionord' }]);
    const json = JSON.stringify(output(got, 'https://studio-nord.de/'));
    for (const leak of ['anna.berg', 'p.holm', 'tracker@', 'anna-berg', 'peter-holm', '49301234567']) assert.ok(!json.includes(leak), leak);
});

test('hard rule on every fixture: only allowlisted addresses come out, and the fixtures hold no real personal address', () => {
    const address = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
    let madeUp = 0;
    for (const name of Object.keys(SOURCES)) {
        const raw = fixture(name);
        for (const found of raw.match(address) ?? []) {
            const { kind, address: a } = classifyEmail(found);
            if (kind === 'other') {
                assert.ok(a.endsWith('@madeup-fixture.test'), `${name} holds an address that is neither a role address nor made up`);
                madeUp++;
            }
        }
        const got = page(name);
        for (const a of got.emails.role) assert.ok(isRoleLocalPart(a.split('@')[0]), `${name}: ${a}`);
        const json = JSON.stringify(output(got, SOURCES[name]));
        assert.ok(!json.includes('madeup-fixture'), `${name}: a non-role address leaked into the output fields`);
        for (const found of json.match(address) ?? []) assert.equal(classifyEmail(found).kind, 'role', `${name}: ${found}`);
    }
    assert.ok(madeUp >= 10, 'the fixtures should contain non-role addresses for this test to mean something');
});

// ---------------------------------------------------------------- responses

test('decodeBody and isHtml', () => {
    assert.equal(decodeBody(Buffer.from('<p>caf\xe9</p>', 'latin1'), 'text/html; charset=ISO-8859-1'), '<p>café</p>');
    assert.equal(decodeBody(Buffer.from('<html><head><meta charset="windows-1252"></head><p>M\xfcnchen</p>', 'latin1')), '<html><head><meta charset="windows-1252"></head><p>München</p>');
    assert.equal(decodeBody(Buffer.from('<p>München</p>', 'utf8'), 'text/html'), '<p>München</p>');
    assert.equal(decodeBody(Buffer.from('<p>x</p>'), 'text/html; charset=no-such-charset'), '<p>x</p>');
    assert.ok(isHtml('text/html; charset=utf-8'));
    assert.ok(isHtml('application/xhtml+xml'));
    assert.ok(!isHtml('application/pdf'));
    assert.ok(!isHtml('application/json'));
    assert.ok(isHtml('', '<!DOCTYPE html><html>'));
    assert.ok(!isHtml('', '%PDF-1.4'));
});
