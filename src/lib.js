// Pure functions: input checks, URL handling and parsing of a website's pages (contact links, forms, social profiles, role addresses).
// No network and no Apify SDK here, so everything in this file is unit-tested on saved fixtures.
import { createHash } from 'node:crypto';

import * as cheerio from 'cheerio';

export const MAX_SITES = 1000;
export const DEFAULT_PAGES_PER_SITE = 4;
export const MAX_PAGES_PER_SITE = 8;
export const MAX_EMAILS = 20;

export class InputError extends Error {}

// ---------------------------------------------------------------- input

/** Turns one "websites" entry (URL or bare domain) into a target: { url, host, source }. Empty entries give null. */
export function parseWebsite(entry) {
    const raw = String(entry).trim();
    if (!raw) return null;
    let url;
    try {
        url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
        throw new InputError(`"${raw}" is not a valid website address.`);
    }
    const host = url.hostname.toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) || url.username || url.password) throw new InputError(`"${raw}" is not a valid website address.`);
    url.hash = '';
    return { url: url.href, host, source: raw };
}

/** Validates the raw Actor input and fills defaults. Throws InputError with a message a user can act on. */
export function normalizeInput(raw) {
    const input = raw ?? {};
    let { websites } = input;
    if (typeof websites === 'string') websites = websites.split(/\r?\n/);
    if (!Array.isArray(websites)) {
        throw new InputError('Input field "websites" is required: a list of website addresses, e.g. ["https://basecamp.com", "plausible.io"].');
    }
    const targets = [];
    const seen = new Set();
    for (const entry of websites) {
        const value = entry && typeof entry === 'object' ? entry.url : entry; // also accepts [{ url }] (Apify request list)
        if (typeof value !== 'string') throw new InputError('Every entry of "websites" must be a text string.');
        const target = parseWebsite(value);
        if (!target || seen.has(target.url)) continue;
        seen.add(target.url);
        targets.push(target);
    }
    if (targets.length === 0) throw new InputError('Input field "websites" is empty: give at least one website address.');
    if (targets.length > MAX_SITES) throw new InputError(`Too many websites: ${targets.length}. The limit is ${MAX_SITES} per run.`);

    let maxPagesPerSite = DEFAULT_PAGES_PER_SITE;
    if (input.maxPagesPerSite != null && input.maxPagesPerSite !== '') {
        maxPagesPerSite = Number(input.maxPagesPerSite);
        if (!Number.isInteger(maxPagesPerSite) || maxPagesPerSite < 1 || maxPagesPerSite > MAX_PAGES_PER_SITE) {
            throw new InputError(`"maxPagesPerSite" must be a whole number from 1 to ${MAX_PAGES_PER_SITE}.`);
        }
    }
    return { targets, maxPagesPerSite, proxyConfiguration: input.proxyConfiguration ?? null };
}

// ---------------------------------------------------------------- URLs

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'or', 'ne', 'gv']);

/** The registrable domain, by a simple rule (no public-suffix list): "shop.example.co.uk" -> "example.co.uk". */
export function siteKey(host) {
    const labels = String(host).toLowerCase().replace(/\.$/, '').split('.');
    if (labels.length <= 2) return labels.join('.');
    const n = labels.at(-1).length === 2 && SECOND_LEVEL.has(labels.at(-2)) ? 3 : 2;
    return labels.slice(-n).join('.');
}

const EMAIL_IN_TEXT = /[a-z0-9._%+-]+(?:@|%40)[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Removes anything that looks like an address from a text (titles, site names). */
export const redactEmails = (text) => (text == null ? text : String(text).replace(EMAIL_IN_TEXT, '').replace(/\s{2,}/g, ' ').trim());

/** A URL safe to output: no fragment, and no query string or path part that carries an address. */
export function sanitizeUrl(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    url.hash = '';
    url.username = '';
    url.password = '';
    EMAIL_IN_TEXT.lastIndex = 0;
    if (EMAIL_IN_TEXT.test(decodeSafe(url.search))) url.search = '';
    EMAIL_IN_TEXT.lastIndex = 0;
    if (EMAIL_IN_TEXT.test(decodeSafe(url.pathname))) return null;
    return url.href;
}

function decodeSafe(text) {
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
}

// ---------------------------------------------------------------- email addresses

/**
 * The allowlist. An address is output only when its local part (the text before @, lower-cased) is exactly one of these
 * role names. Everything else is treated as possibly personal and is never output: only counted.
 */
export const ROLE_LOCAL_PARTS = new Set(`
info information infos contact contacts contactus contact-us contact.us hello hi hey sales support help helpdesk office admin
administration press media pr marketing careers career jobs job hr recruiting recruitment talent billing accounts accounting
finance invoices invoice payments enquiries enquiry inquiries inquiry team service services customerservice customer-service
customer.service customercare customer-care customersupport customer-support customers care mail email post booking bookings
reservations reservation orders order shop store partnerships partners partner legal privacy security abuse webmaster
postmaster hostmaster feedback general reception welcome connect ask questions business bizdev wholesale events newsletter
news editor editorial compliance dpo gdpr dataprotection data-protection investors ir community membership members donations
volunteer education training returns shipping tech techsupport it dev developers api design studio sponsorship advertising
ads affiliates licensing purchasing procurement operations ops quotes quote estimates rentals appointments frontdesk
front-desk headoffice hq trade export tickets groups admissions library custom b2b schools catering gifts corporate online web
digital handel kommunikation
kontakt anfrage anfragen vertrieb verkauf buchhaltung bewerbung bewerbungen karriere presse datenschutz kundenservice
kundendienst zentrale sekretariat verwaltung redaktion bestellung bestellungen buero empfang rechnung einkauf praxis kanzlei
rezeption hallo impressum technik
bonjour accueil commercial ventes recrutement emploi compta comptabilite secretariat commandes sav serviceclient
service-client communication rgpd mairie
contacto hola ventas soporte ayuda prensa administracion atencion atencionalcliente clientes informacion pedidos reservas
empleo rrhh facturacion oficina recepcion comunicacion
contatti contatto ciao vendite supporto assistenza stampa amministrazione segreteria commerciale ordini prenotazioni lavoro
ufficio clienti
contato ola vendas suporte atendimento imprensa comercial financeiro geral sac secretaria rh
verkoop klantenservice administratie receptie vacatures pers bestellingen boekhouding secretariaat
hej hei salg kundeservice kundservice kundtjanst biuro sklep sprzedaz rekrutacja praca obsluga pomoc zamowienia firmapost
`.split(/\s+/).filter(Boolean));

// Not addresses anyone can write to, or not addresses at all: dropped and not counted.
const JUNK_LOCAL_PARTS = new Set(['noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply', 'do_not_reply', 'mailer-daemon', 'bounce', 'bounces',
    'you', 'your', 'name', 'yourname', 'your-name', 'your.name', 'youremail', 'your-email', 'your.email', 'user', 'username', 'someone', 'somebody',
    'example', 'test', 'email', 'mail', 'address', 'emailaddress', 'firstname.lastname', 'first.last', 'john.doe', 'jane.doe', 'johndoe', 'janedoe',
    'max.mustermann', 'mustermann', 'nom', 'prenom.nom', 'nombre', 'nome', 'naam', 'xxx', 'xxxx', 'abc', 'foo', 'bar']);
const PLACEHOLDER_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'example.de', 'example.co.uk', 'domain.com', 'domain.tld', 'domain.de',
    'yourdomain.com', 'your-domain.com', 'yourcompany.com', 'yoursite.com', 'yourwebsite.com', 'mydomain.com', 'mysite.com', 'company.com', 'website.com',
    'test.com', 'sample.com', 'beispiel.de', 'musterfirma.de', 'mustermann.de', 'domaine.fr', 'domaine.com', 'exemple.com',
    'exemple.fr', 'ejemplo.com', 'esempio.it', 'dominio.com', 'dominio.it', 'voorbeeld.nl', 'sentry.io', 'wixpress.com', 'sentry-next.wixpress.com',
    'mysite.co', 'address.com', 'mail.com.example', 'placeholder.com', 'acme.com', 'godaddy.com', 'wix.com', 'squarespace.com']);
const FILE_TLDS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico', 'bmp', 'tif', 'tiff', 'css', 'js', 'mjs', 'json', 'map', 'html', 'htm',
    'php', 'asp', 'aspx', 'xml', 'pdf', 'woff', 'woff2', 'ttf', 'eot', 'otf', 'mp4', 'webm', 'mp3', 'mov', 'zip', 'txt', 'md', 'ts', 'tsx', 'jsx', 'vue', 'scss']);

export const isRoleLocalPart = (local) => ROLE_LOCAL_PARTS.has(String(local).toLowerCase());

/**
 * Sorts one address candidate into "role" (may be output), "other" (never output, only counted) or "junk"
 * (file names, placeholders, tracking ids: dropped). Returns { kind, address } with the address lower-cased.
 */
export function classifyEmail(candidate) {
    const address = String(candidate).trim().toLowerCase().replace(/^[.\-_%+]+/, '').replace(/[.\-]+$/, '');
    const at = address.lastIndexOf('@');
    if (at < 1 || address.indexOf('@') !== at) return { kind: 'junk', address };
    const local = address.slice(0, at);
    const domain = address.slice(at + 1);
    const labels = domain.split('.');
    const tld = labels.at(-1);
    if (local.length > 64 || domain.length > 253 || labels.length < 2 || labels.some((l) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(l))) return { kind: 'junk', address };
    if (!/^[a-z0-9._%+-]+$/.test(local) || /\.\./.test(local) || local.endsWith('.')) return { kind: 'junk', address };
    if (!/^[a-z]{2,24}$/.test(tld) || FILE_TLDS.has(tld)) return { kind: 'junk', address }; // logo@2x.png
    if (/^\d+x$/.test(labels[0]) && labels.length === 2) return { kind: 'junk', address }; // image@2x.something
    if (PLACEHOLDER_DOMAINS.has(domain) || [...PLACEHOLDER_DOMAINS].some((d) => domain.endsWith(`.${d}`))) return { kind: 'junk', address };
    if (/^[0-9a-f]{16,}$/.test(local) || /^[0-9]+$/.test(local)) return { kind: 'junk', address }; // tracking ids (Sentry keys)
    if (isRoleLocalPart(local)) return { kind: 'role', address };
    if (JUNK_LOCAL_PARTS.has(local)) return { kind: 'junk', address };
    return { kind: 'other', address };
}

/** Decodes Cloudflare's "email protection" hex string (the first byte is the XOR key). */
export function decodeCfEmail(hex) {
    if (!/^(?:[0-9a-f]{2}){2,}$/i.test(hex)) return null;
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return out;
}

const ADDRESS = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/gi;

/** Address candidates in a plain text, after undoing the simple bracketed obfuscations: "info [at] site [dot] com", "info(at)site.de". */
export function findAddresses(text) {
    const plain = String(text ?? '')
        .replace(/(@[a-z0-9.-]+\.[a-z]{2,10})(?=[A-Z][a-z])/g, '$1 ') // "info@site.comCall us": a word stuck to the address
        .replace(/\s*[[({]\s*(?:at|ät)\s*[\])}]\s*/gi, '@')
        .replace(/\s*[[({]\s*(?:dot|punkt|point|punto)\s*[\])}]\s*/gi, '.');
    return plain.match(ADDRESS) ?? [];
}

const fingerprint = (address) => createHash('sha256').update(address).digest('hex').slice(0, 16);

/**
 * Sorts address candidates. Returns { role: [addresses], otherHashes: [short hashes] }.
 * Addresses that are not on the allowlist leave this function only as a hash, so that distinct ones can be counted
 * across pages without the address itself ever reaching the dataset, the summary or the log.
 */
export function sortAddresses(candidates) {
    const role = new Set();
    const other = new Set();
    for (const candidate of candidates) {
        const { kind, address } = classifyEmail(candidate);
        if (kind === 'role') role.add(address);
        else if (kind === 'other') other.add(fingerprint(address));
    }
    return { role: [...role], otherHashes: [...other] };
}

// ---------------------------------------------------------------- social profiles

export const NETWORKS = ['linkedin', 'twitter', 'facebook', 'instagram', 'youtube', 'tiktok', 'github'];

const RESERVED = {
    twitter: new Set(['intent', 'share', 'home', 'search', 'hashtag', 'i', 'login', 'signup', 'privacy', 'tos', 'settings', 'explore', 'messages', 'notifications', 'compose', 'widgets', 'about', 'download', 'account', 'en', 'oauth', 'sharer']),
    facebook: new Set(['sharer', 'sharer.php', 'share.php', 'share', 'dialog', 'plugins', 'tr', 'tr.php', 'login', 'login.php', 'help', 'policy', 'policy.php', 'policies', 'privacy', 'legal', 'terms', 'terms.php', 'about', 'ads', 'business', 'events', 'hashtag', 'watch', 'marketplace', 'gaming', 'l.php', 'home.php', 'photo.php', 'photo', 'photos', 'video.php', 'story.php', 'permalink.php', 'settings', 'recover', 'reg', 'r.php', 'sem_campaigns', 'v2.0', 'docs', 'groups', '2008']),
    instagram: new Set(['p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'tv', 'about', 'legal', 'developer', 'direct', 'share', 'sharer', 'web']),
    youtube: new Set(['watch', 'embed', 'playlist', 'results', 'shorts', 'feed', 'live', 'v', 'e', 'about', 't', 'yt', 'account', 'premium', 'gaming', 'music', 'kids', 'tv', 'intl', 'howyoutubeworks', 'ads', 'creators', 'redirect', 'signin', 'iframe_api', 'player_api', 'subscription_center', 'share', 's', 'yts', 'hashtag', 'clip', 'post', 'trending', 'upload', 'oembed']),
    github: new Set(['features', 'pricing', 'login', 'join', 'signup', 'about', 'sponsors', 'marketplace', 'topics', 'explore', 'enterprise', 'security', 'site', 'contact', 'customer-stories', 'readme', 'collections', 'trending', 'events', 'orgs', 'apps', 'settings', 'notifications', 'issues', 'pulls', 'search', 'share', 'team', 'solutions', 'resources', 'open-source', 'premium-support', 'git-guides', 'mobile', 'home', 'new', 'organizations', 'codespaces', 'copilot', 'discussions', 'education', 'blog', 'press', 'logos', 'nonprofit', 'personal', 'gist', 'user-attachments', 'edu']),
};

/**
 * A link to a social network turned into a clean profile URL: { network, url }, or null when the link is not a profile
 * (share buttons, single posts, the network's own pages) or is a personal LinkedIn profile.
 */
export function cleanSocialUrl(href) {
    let url;
    try {
        url = new URL(String(href).trim());
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    let host = url.hostname.toLowerCase();
    if (host.split('.').length >= 3) host = host.replace(/^(?:www|m|mobile|web|[a-z]{2}(?:-[a-z]{2})?)\./, ''); // www., m., de., en-gb.
    const seg = url.pathname.split('/').filter(Boolean).map(decodeSafe);
    const first = (seg[0] ?? '').toLowerCase();
    if (!first) return null;

    if (host === 'linkedin.com') {
        // Organisation pages only. "/in/..." and "/pub/..." are people: never kept.
        if (!['company', 'school', 'showcase'].includes(first) || !seg[1] || !/^[\p{L}\p{N}_.%&'-]+$/u.test(seg[1])) return null;
        return { network: 'linkedin', url: `https://www.linkedin.com/${first}/${encodeURIComponent(seg[1]).toLowerCase()}` };
    }
    if (host === 'twitter.com' || host === 'x.com') {
        const handle = seg[0].replace(/^@/, '');
        if (RESERVED.twitter.has(first) || !/^[A-Za-z0-9_]{1,15}$/.test(handle) || (seg[1] && ['status', 'statuses'].includes(seg[1].toLowerCase()))) return null;
        return { network: 'twitter', url: `https://x.com/${handle}` };
    }
    if (host === 'facebook.com' || host === 'fb.com' || host === 'fb.me') {
        if (first === 'profile.php') {
            const id = url.searchParams.get('id');
            return id && /^\d+$/.test(id) ? { network: 'facebook', url: `https://www.facebook.com/profile.php?id=${id}` } : null;
        }
        if ((first === 'pages' || first === 'people' || first === 'p') && seg.length >= 2) {
            const rest = seg.slice(1, first === 'p' ? 2 : 3).map(encodeURIComponent).join('/');
            return { network: 'facebook', url: `https://www.facebook.com/${first}/${rest}` };
        }
        if (RESERVED.facebook.has(first) || first.endsWith('.php') || !/^[\p{L}\p{N}.\-_]+$/u.test(seg[0])) return null;
        return { network: 'facebook', url: `https://www.facebook.com/${encodeURIComponent(seg[0])}` };
    }
    if (host === 'instagram.com') {
        if (RESERVED.instagram.has(first) || !/^[A-Za-z0-9._]{1,30}$/.test(seg[0])) return null;
        return { network: 'instagram', url: `https://www.instagram.com/${seg[0]}` };
    }
    if (host === 'youtube.com') {
        if (first.startsWith('@') && /^@[\p{L}\p{N}._-]{2,}$/u.test(seg[0])) return { network: 'youtube', url: `https://www.youtube.com/${seg[0]}` };
        if (['channel', 'c', 'user'].includes(first) && seg[1] && /^[\p{L}\p{N}._-]+$/u.test(seg[1])) return { network: 'youtube', url: `https://www.youtube.com/${first}/${seg[1]}` };
        if (RESERVED.youtube.has(first) || seg.length > 1 || !/^[A-Za-z0-9_-]{2,}$/.test(seg[0])) return null;
        return { network: 'youtube', url: `https://www.youtube.com/${seg[0]}` };
    }
    if (host === 'tiktok.com') {
        if (!/^@[A-Za-z0-9._]{2,24}$/.test(seg[0]) || seg[1]) return null;
        return { network: 'tiktok', url: `https://www.tiktok.com/${seg[0]}` };
    }
    if (host === 'github.com') {
        if (RESERVED.github.has(first) || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(seg[0])) return null;
        return { network: 'github', url: `https://github.com/${seg[0]}` };
    }
    return null;
}

/** The profile per network that is linked most often (ties: the first seen). `found` is a list of { network, url } in page order. */
export function pickSocialProfiles(found) {
    const out = Object.fromEntries(NETWORKS.map((n) => [n, null]));
    const counts = new Map();
    for (const { network, url } of found) {
        const key = `${network}|${url.toLowerCase()}`;
        const entry = counts.get(key) ?? { network, url, n: 0, order: counts.size };
        entry.n++;
        counts.set(key, entry);
    }
    for (const network of NETWORKS) {
        const best = [...counts.values()].filter((e) => e.network === network).sort((a, b) => b.n - a.n || a.order - b.order)[0];
        if (best) out[network] = best.url;
    }
    return out;
}

// ---------------------------------------------------------------- contact links

const norm = (text) => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[\s ]+/g, ' ').trim();

const CONTACT_SEGMENTS = new Set(['contact', 'contacts', 'contact-us', 'contactus', 'contact_us', 'kontakt', 'kontakte', 'kontaktformular', 'contacto',
    'contactos', 'contactenos', 'contactanos', 'contactar', 'contatti', 'contatto', 'contattaci', 'contato', 'fale-conosco', 'faleconosco',
    'nous-contacter', 'contactez-nous', 'contacter', 'get-in-touch', 'getintouch', 'reach-us', 'kontakta-oss', 'kontakt-oss', 'kontakta',
    'yhteystiedot', 'neem-contact-op', 'kontakty', 'kapcsolat', 'iletisim', 'talk-to-us', 'say-hello', 'lets-talk', 'contattami', 'kontaktiere-uns']);
const CONTACT_WORDS = new Set(['contact', 'contacts', 'contactus', 'kontakt', 'kontakte', 'kontaktformular', 'contacto', 'contactos', 'contatti', 'contatto',
    'contato', 'contacter', 'contactez', 'kontakty', 'kontakta']);
const SUPPORT_SEGMENTS = new Set(['support', 'help', 'helpdesk', 'help-center', 'helpcenter', 'help-centre', 'customer-service', 'customer-support',
    'customer-care', 'customerservice', 'kundenservice', 'kundendienst', 'hilfe', 'aide', 'ayuda', 'soporte', 'assistenza', 'supporto',
    'service-client', 'klantenservice', 'kundeservice', 'kundservice', 'suporte', 'atendimento', 'pomoc']);
const NOTICE_SEGMENTS = new Set(['impressum', 'imprint', 'legal-notice', 'mentions-legales', 'aviso-legal', 'note-legali', 'colofon']);
const ABOUT_SEGMENTS = new Set(['about', 'about-us', 'aboutus', 'about_us', 'ueber-uns', 'uber-uns', 'a-propos', 'qui-sommes-nous', 'sobre-nosotros',
    'quienes-somos', 'chi-siamo', 'over-ons', 'om-oss', 'om-os', 'sobre', 'sobre-nos', 'quem-somos', 'o-nas', 'company', 'unternehmen']);

const CONTACT_TEXT = /\b(?:contact|contacts|kontakt|kontakte|kontaktieren|contacto|contactar|contactanos|contactenos|contatti|contatto|contattaci|contato|contactez|contacter|get in touch|talk to us|reach us|reach out|kontakta|kontakty|yhteystiedot|fale conosco|say hello|neem contact)\b/;
const SUPPORT_TEXT = /\b(?:support|help|help center|help centre|customer service|customer care|kundenservice|hilfe|aide|ayuda|soporte|assistenza|supporto|service client|klantenservice|suporte)\b/;
const NOTICE_TEXT = /\b(?:impressum|imprint|legal notice|mentions legales|aviso legal|note legali)\b/;
const ABOUT_TEXT = /^(?:about|about us|uber uns|ueber uns|a propos|qui sommes-nous|qui sommes nous|sobre nosotros|quienes somos|chi siamo|over ons|om oss|sobre nos|quem somos|company)$/;
const NOT_A_PAGE = /\.(?:pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|pptx?|mp[34]|ics|vcf|xml|rss|css|js)$/i;
const ARTICLE_PATH = /\/(?:blog|blogs|news|article|articles|post|posts|tag|tags|category|categories|product|products|docs|doc|documentation|changelog|jobs|careers|forum|community|wiki|kb|hc|magazine|stories|press)\//;

const KIND_RANK = { contact: 3, support: 2, notice: 1, about: 1 };

/** Scores one link as a contact page candidate. Returns { score, kind } or null when it is no candidate. */
export function scoreLink(url, text) {
    const segments = url.pathname.split('/').filter(Boolean).map((s) => norm(decodeSafe(s)).replace(/\.(?:html?|php|aspx?|jsp)$/, ''));
    const last = segments.at(-1) ?? '';
    const t = norm(text).replace(/[»›→>|•:]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (ARTICLE_PATH.test(`${url.pathname}/`) && !CONTACT_SEGMENTS.has(last)) return null; // an article or product that mentions "contact"
    const words = last.split(/[-_.+]/);
    let path = 0;
    let pathKind = null;
    if (CONTACT_SEGMENTS.has(last)) [path, pathKind] = [100, 'contact'];
    else if (CONTACT_WORDS.has(words[0]) || CONTACT_WORDS.has(words.at(-1))) [path, pathKind] = [80, 'contact']; // "kontakt-c1994", "contact-sales"; not "kontaktgrill"
    else if (segments.some((s) => CONTACT_SEGMENTS.has(s))) [path, pathKind] = [65, 'contact'];
    else if (SUPPORT_SEGMENTS.has(last)) [path, pathKind] = [40, 'support'];
    else if (NOTICE_SEGMENTS.has(last)) [path, pathKind] = [25, 'notice'];
    else if (ABOUT_SEGMENTS.has(last)) [path, pathKind] = [20, 'about'];
    else if (segments.length === 0 && /^(?:support|help|kontakt|contact)\./.test(url.hostname)) [path, pathKind] = [35, /^(?:kontakt|contact)\./.test(url.hostname) ? 'contact' : 'support'];

    let word = 0;
    let wordKind = null;
    if (t && t.length <= 40) {
        if (CONTACT_TEXT.test(t)) [word, wordKind] = [t.length <= 20 ? 60 : 40, 'contact'];
        else if (SUPPORT_TEXT.test(t) && t.length <= 25) [word, wordKind] = [25, 'support'];
        else if (NOTICE_TEXT.test(t)) [word, wordKind] = [15, 'notice'];
        else if (ABOUT_TEXT.test(t)) [word, wordKind] = [12, 'about'];
    }
    if (!pathKind && !wordKind) return null;

    const kind = !wordKind || (pathKind && KIND_RANK[pathKind] >= KIND_RANK[wordKind]) ? pathKind : wordKind;
    let score = path + word;
    if (segments.length > 3) score -= 15;
    if (url.search) score -= 10;
    if (score <= 0) return null;
    return { score, kind };
}

/**
 * Contact page candidates among a page's links, best first: [{ url, score, kind, inPage }].
 * Only links to the same site count. `inPage` marks a link to a section of the page itself ("#contact").
 */
export function rankContactCandidates(links, pageUrl) {
    const base = new URL(pageUrl);
    const site = siteKey(base.hostname);
    const here = `${base.origin}${base.pathname.replace(/\/$/, '')}${base.search}`;
    const best = new Map();
    links.forEach((link, order) => {
        let url;
        try {
            url = new URL(link.href, base);
        } catch {
            return;
        }
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') || siteKey(url.hostname) !== site || NOT_A_PAGE.test(url.pathname)) return;
        const fragment = norm(decodeSafe(url.hash.slice(1)));
        const clean = sanitizeUrl(url.href);
        if (!clean) return;
        const inPage = `${url.origin}${url.pathname.replace(/\/$/, '')}${url.search}` === here;
        let scored;
        if (inPage) {
            // A link to the page itself only counts when it points at a contact section.
            const hit = /contact|kontakt|contatt|contato/.test(fragment) || (fragment && CONTACT_TEXT.test(norm(link.text)));
            scored = hit ? { score: 50, kind: 'contact' } : null;
        } else {
            scored = scoreLink(url, link.text);
        }
        if (!scored) return;
        if (url.hostname !== base.hostname && url.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) scored.score -= 10;
        const key = inPage ? '#' : clean.replace(/\/$/, '').toLowerCase();
        const prev = best.get(key);
        if (!prev || scored.score > prev.score) best.set(key, { url: inPage ? `${clean}${url.hash}` : clean, score: scored.score, kind: scored.kind, inPage, order: prev?.order ?? order });
    });
    return [...best.values()]
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score || a.url.length - b.url.length || a.order - b.order)
        .map(({ order, ...c }) => c);
}

/** A candidate good enough to be taken as the contact page without trying anything else. */
export const isStrongCandidate = (c) => c.kind === 'contact' && c.score >= 50 && !c.inPage;

/** Addresses to try when the homepage links to no contact page: the usual paths, the site's own language first. */
export function guessUrls(finalUrl, lang) {
    const { origin } = new URL(finalUrl);
    const l = String(lang ?? '').toLowerCase().slice(0, 2);
    const first = { de: 'kontakt', pl: 'kontakt', cs: 'kontakt', sv: 'kontakt', da: 'kontakt', nb: 'kontakt', no: 'kontakt', es: 'contacto', it: 'contatti', pt: 'contato' }[l];
    return (first ? [first, 'contact'] : ['contact', 'contact-us']).map((p) => `${origin}/${p}`);
}

// ---------------------------------------------------------------- forms

const MESSAGE_FIELD = /message|nachricht|mensaje|messaggio|mensagem|bericht|comment|comentario|commentaire|enquiry|inquiry|anfrage|question|subject|betreff|asunto|sujet|oggetto|how.?can.?we|your.?msg|description|details|anliegen|demande/;
const NEWSLETTER = /newsletter|subscribe|subscription|signup|sign-up|sign_up|mailchimp|mc-embedded|klaviyo|abonn|anmeld.*newsletter|mailing.?list|email.?list|notify|waitlist/;
const SEARCH = /search|suche|recherche|buscar|busqueda|cerca|zoeken/;
const EMBEDDED_FORM = /hbspt\.forms\.create|js\.hsforms\.net|(?:src|href)=["'][^"']*(?:typeform\.com\/to\/|form\.jotform\.com|jotform\.com\/form|docs\.google\.com\/forms|tally\.so\/(?:r|embed)|forms\.office\.com|airtable\.com\/embed\/[^"']*form|form\.typeform\.com|paperform\.co|formstack\.com\/forms|cognitoforms\.com|wufoo\.com\/forms)/i;

/**
 * Is there a form on the page that a visitor can write a message with?
 * Returns "html" (a <form> with a message field, or with an email field plus other fields), "embed" (a form service
 * loaded into the page: HubSpot, Typeform, Jotform, Google Forms, Tally...), or null. Search, login and
 * newsletter-only forms do not count.
 */
export function detectContactForm($, html = '') {
    let found = false;
    $('form').each((_, el) => {
        if (found) return;
        const form = $(el);
        const marks = norm([form.attr('id'), form.attr('class'), form.attr('name'), form.attr('action'), form.attr('aria-label'), form.attr('role')].filter(Boolean).join(' '));
        if (form.attr('role') === 'search' || form.find('input[type=password]').length > 0) return;
        if (form.find('input[type=search]').length > 0 && form.find('textarea').length === 0) return;
        const fields = form.find('input, textarea, select').toArray().map((f) => {
            const a = f.attribs ?? {};
            return { tag: f.tagName.toLowerCase(), type: (a.type ?? 'text').toLowerCase(), label: norm([a.name, a.id, a.placeholder, a['aria-label'], a.autocomplete].filter(Boolean).join(' ')) };
        }).filter((f) => !['hidden', 'submit', 'button', 'image', 'reset', 'checkbox', 'radio', 'file'].includes(f.type) && !/recaptcha|captcha|honeypot|hp_|_gotcha/.test(f.label));
        if (fields.length === 0) return;
        const hasTextarea = fields.some((f) => f.tag === 'textarea');
        const hasMessage = hasTextarea || fields.some((f) => MESSAGE_FIELD.test(f.label));
        const hasEmail = fields.some((f) => f.type === 'email' || /e-?mail/.test(f.label));
        const newsletter = NEWSLETTER.test(marks);
        if (!hasMessage && fields.length <= 2 && fields.some((f) => SEARCH.test(f.label) || f.label === 'q' || f.label === 's')) return;
        if (SEARCH.test(marks) && !hasMessage) return;
        if (hasMessage && (hasEmail || fields.length >= 2 || hasTextarea)) found = true; // a message box
        else if (hasEmail && fields.length >= 3 && !newsletter) found = true; // name, email, company...: a request form
    });
    if (found) return 'html';
    return EMBEDDED_FORM.test(html) ? 'embed' : null;
}

// ---------------------------------------------------------------- pages

const BLOCK_TITLES = /^(?:just a moment|attention required|access denied|access to this page has been denied|are you a robot|robot check|security check|pardon our interruption|please verify you are a human|captcha|403 forbidden|blocked|request blocked|verifying)/i;

/** Decodes a response body with the charset from the Content-Type header or the page's own <meta>. */
export function decodeBody(bytes, contentType = '') {
    let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
    if (!charset) {
        const head = Buffer.from(bytes.subarray(0, 2048)).toString('latin1');
        charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
    }
    try {
        return new TextDecoder(charset || 'utf-8').decode(bytes);
    } catch {
        return new TextDecoder('utf-8').decode(bytes);
    }
}

/** True when the Content-Type (or, without one, the body's start) says the response is an HTML page. */
export function isHtml(contentType, bodyStart = '') {
    if (contentType) return /text\/html|application\/xhtml\+xml/i.test(contentType);
    return /<!doctype html|<html[\s>]/i.test(bodyStart);
}

/**
 * Everything the Actor reads from one page:
 * { title, siteName, lang, blocked, links, emails: { role, otherHashes }, socials, form, looksLikeContact }.
 */
export function parsePage(html, pageUrl) {
    const $ = cheerio.load(html);
    const title = redactEmails($('title').first().text().replace(/\s+/g, ' ').trim()) || null;
    const siteName = redactEmails(($('meta[property="og:site_name"]').attr('content') ?? $('meta[name="application-name"]').attr('content') ?? '').replace(/\s+/g, ' ').trim()) || null;
    const lang = ($('html').attr('lang') ?? '').trim().toLowerCase() || null;

    const links = [];
    const candidates = [];
    const socials = [];
    $('a[href], area[href]').each((_, el) => {
        const a = $(el);
        const href = (a.attr('href') ?? '').trim();
        if (!href) return;
        if (/^mailto:/i.test(href)) {
            for (const part of decodeSafe(href.slice(7).split('?')[0]).split(/[,;]/)) candidates.push(part);
            return;
        }
        const cf = /\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/i.exec(href);
        if (cf) {
            const decoded = decodeCfEmail(cf[1]);
            if (decoded) candidates.push(decoded);
            return;
        }
        if (/^(?:tel|sms|javascript|data|whatsapp|skype|callto|fax):/i.test(href)) return;
        let absolute;
        try {
            absolute = new URL(href, pageUrl).href;
        } catch {
            return;
        }
        const social = cleanSocialUrl(absolute);
        if (social) socials.push(social);
        const text = [a.text(), a.attr('aria-label'), a.attr('title'), a.find('img[alt]').attr('alt')].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 120);
        links.push({ href: absolute, text });
    });
    $('[data-cfemail]').each((_, el) => {
        const decoded = decodeCfEmail($(el).attr('data-cfemail') ?? '');
        if (decoded) candidates.push(decoded);
    });
    // Structured data often carries the organisation's address and profiles.
    $('script[type="application/ld+json"]').each((_, el) => {
        const json = $(el).text();
        for (const m of json.matchAll(/"email"\s*:\s*"(?:mailto:)?([^"]+)"/gi)) candidates.push(m[1]);
        for (const m of json.matchAll(/"(https?:(?:\\\/|\/){2}[^"]+)"/g)) {
            const social = cleanSocialUrl(m[1].replace(/\\\//g, '/'));
            if (social) socials.push(social);
        }
    });

    const form = detectContactForm($, html);

    // Visible text: tags become spaces so that neighbouring words never stick to an address.
    $('script, style, noscript, svg, template, head').remove();
    const heading = norm($('h1').first().text()).slice(0, 200);
    const text = cheerio.load(($('body').html() ?? '').replace(/<[^>]+>/g, ' ')).text().replace(/[\s ]+/g, ' ');
    candidates.push(...findAddresses(text));

    const head = `${norm(title)} | ${heading}`;
    return {
        title,
        siteName,
        lang,
        blocked: BLOCK_TITLES.test(title ?? '') && text.length < 3000,
        links,
        emails: sortAddresses(candidates),
        socials,
        form,
        looksLikeContact: !/\b(?:404|not found|page introuvable|nicht gefunden|no encontrada|non trovata)\b/.test(head) && (CONTACT_TEXT.test(head) || form !== null),
    };
}

/** Links to pages that often carry the organisation's address (legal notice, other contact pages, about), best first. */
export function emailSourceCandidates(candidates) {
    const rank = { notice: 0, contact: 1, about: 2, support: 3 };
    return candidates.filter((c) => !c.inPage).sort((a, b) => rank[a.kind] - rank[b.kind] || b.score - a.score);
}

/** Role addresses for output: the site's own domain first, then alphabetical; capped. */
export function orderEmails(addresses, host) {
    const site = siteKey(host);
    const own = (a) => (siteKey(a.slice(a.lastIndexOf('@') + 1)) === site ? 0 : 1);
    return [...new Set(addresses)].sort((a, b) => own(a) - own(b) || a.localeCompare(b)).slice(0, MAX_EMAILS);
}
