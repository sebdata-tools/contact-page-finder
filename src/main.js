// Contact Page Finder: for each website, its contact page, whether it has a contact form, its social profiles and its
// role-based addresses (info@, sales@). Personal addresses are never output: see ROLE_LOCAL_PARTS in lib.js.
import { Actor, log } from 'apify';
import { ProxyAgent, fetch } from 'undici';

import {
    InputError, decodeBody, emailSourceCandidates, guessUrls, isHtml, isStrongCandidate, normalizeInput, orderEmails, parsePage,
    pickSocialProfiles, rankContactCandidates, sanitizeUrl,
} from './lib.js';

const EVENT = 'site';
// An honest agent. Measured on 40 sites (2026-11-14): this and a Firefox agent were let in by exactly the same 27,
// so pretending to be a browser buys nothing.
const USER_AGENT = 'Mozilla/5.0 (compatible; contact-page-finder/0.1; Apify Actor; reads public contact pages)';
const HOME_RETRIES = 2; // the homepage is retried; other pages get one attempt
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 2_000_000; // of each page, at most this much is read
const SITE_CONCURRENCY = 8;
const PAGE_DELAY_MS = 250; // pause between pages of the same site

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

class SiteError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/** A failed request as a SiteError with a status the summary can show. */
function classify(err) {
    if (err instanceof SiteError) return err;
    const code = err.cause?.code ?? err.code ?? '';
    if (code === 'ENOTFOUND') return new SiteError('not_found', 'The domain does not exist (DNS lookup failed).');
    if (err.name === 'TimeoutError' || err.name === 'AbortError' || /TIMEOUT|ETIMEDOUT/.test(code)) return new SiteError('timeout', 'The site did not answer in time.');
    return new SiteError('unreachable', `Could not connect: ${code || err.cause?.message || err.message}.`);
}

/**
 * GET one page. Retries network errors, 429 and 5xx with backoff (honours Retry-After), `retries` times.
 * Reads at most MAX_BYTES. Returns { finalUrl, html }; throws SiteError otherwise.
 */
async function request(url, dispatcher, retries, entry) {
    let lastError;
    let wait = 0;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(Math.max(wait, Math.min(1000 * 2 ** (attempt - 1), 8000)) + Math.random() * 500);
        wait = 0;
        try {
            stats.requests++;
            entry.requests++;
            const res = await fetch(url, {
                dispatcher,
                headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'accept-language': 'en-US,en;q=0.9' },
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (res.status === 429 || res.status >= 500) {
                await res.body?.cancel();
                const retryAfter = Number(res.headers.get('retry-after'));
                if (Number.isFinite(retryAfter) && retryAfter > 0) wait = Math.min(retryAfter * 1000, 15_000);
                lastError = res.status === 429
                    ? new SiteError('blocked', 'The site is rate-limiting automated access (HTTP 429).')
                    : new SiteError('http_error', `The site answered with a server error (HTTP ${res.status}).`);
                continue;
            }
            if (!res.ok) {
                await res.body?.cancel();
                const err = res.status === 401 || res.status === 403
                    ? new SiteError('blocked', `The site blocks automated access (HTTP ${res.status}). A proxy in the input may help.`)
                    : new SiteError('http_error', `The address answered HTTP ${res.status}.`);
                err.permanent = true;
                throw err;
            }
            const contentType = res.headers.get('content-type') ?? '';
            if (contentType && !isHtml(contentType)) {
                await res.body?.cancel();
                const err = new SiteError('not_html', `The address is not a web page (${contentType.split(';')[0]}).`);
                err.permanent = true;
                throw err;
            }
            const chunks = [];
            let size = 0;
            if (res.body) {
                const reader = res.body.getReader();
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    size += value.length;
                    if (size >= MAX_BYTES) {
                        await reader.cancel().catch(() => {});
                        break;
                    }
                }
            }
            const html = decodeBody(Buffer.concat(chunks), contentType);
            if (!contentType && !isHtml('', html.slice(0, 2000))) {
                const err = new SiteError('not_html', 'The address is not a web page.');
                err.permanent = true;
                throw err;
            }
            return { finalUrl: res.url || url, html };
        } catch (err) {
            if (err.permanent) throw err;
            lastError = classify(err);
            if (lastError.status === 'not_found') throw lastError; // a domain that does not exist will not appear on a retry
        }
    }
    throw lastError;
}

const stats = { sites: 0, sitesOk: 0, sitesFailed: 0, sitesSkipped: 0, requests: 0, rows: 0 };

await Actor.init();

let input;
try {
    input = normalizeInput(await Actor.getInput());
} catch (err) {
    if (err instanceof InputError) await Actor.fail(`Invalid input: ${err.message}`);
    throw err;
}
stats.sites = input.targets.length;

const proxyConfiguration = input.proxyConfiguration ? await Actor.createProxyConfiguration(input.proxyConfiguration) : undefined;
const proxyUrl = await proxyConfiguration?.newUrl();
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

const chargingManager = Actor.getChargingManager();
const remainingBudget = () => {
    const n = chargingManager.calculateMaxEventChargeCountWithinLimit(EVENT);
    return Number.isFinite(n) ? n : Infinity;
};

let limitReached = false;
let pushing = Promise.resolve(); // pushes run one at a time so the spending limit is checked between them
const report = [];

/** Saves items, never more than the spending limit pays for. Returns how many were saved. */
function pushLimited(items) {
    const job = pushing.then(async () => {
        if (limitReached || items.length === 0) return 0;
        const budget = remainingBudget();
        const batch = items.length > budget ? items.slice(0, budget) : items;
        if (batch.length < items.length) limitReached = true;
        if (batch.length === 0) return 0;
        const charge = await Actor.pushData(batch, EVENT);
        if (charge?.eventChargeLimitReached) limitReached = true;
        stats.rows += batch.length;
        return batch.length;
    });
    pushing = job.catch(() => {});
    return job;
}

/** Reads and parses one page. Throws SiteError when it cannot be read or is a block page. */
async function readPage(url, entry, retries) {
    const { finalUrl, html } = await request(url, dispatcher, retries, entry);
    const page = parsePage(html, finalUrl);
    if (page.blocked) throw new SiteError('blocked', 'The site answered with a bot-check page instead of its content. A proxy in the input may help.');
    return { url: finalUrl, page };
}

const sameAddress = (a, b) => {
    const strip = (u) => u.replace(/#.*$/, '').replace(/\/$/, '').replace(/^https?:\/\/(?:www\.)?/, '').toLowerCase();
    return strip(a) === strip(b);
};

async function findContact(target) {
    const entry = { input: target.source, status: 'ok', finalUrl: null, contactPageMethod: null, pagesFetched: 0, requests: 0 };
    report.push(entry);

    // 1. The homepage. When https cannot connect at all, plain http is tried once.
    let home;
    try {
        try {
            home = await readPage(target.url, entry, HOME_RETRIES);
        } catch (err) {
            if (err.status !== 'unreachable' || !target.url.startsWith('https://')) throw err;
            home = await readPage(target.url.replace(/^https:/, 'http:'), entry, 0).catch(() => { throw err; });
        }
    } catch (err) {
        entry.status = err.status ?? 'unreachable';
        entry.message = err.message;
        stats.sitesFailed++;
        log.warning(`${target.host}: ${entry.message}`);
        return;
    }
    entry.pagesFetched = 1;
    entry.finalUrl = sanitizeUrl(home.url);

    let attempts = 1; // pages asked for, the homepage included: never more than maxPagesPerSite
    const tried = [target.url, home.url];
    const pages = [home.page];
    const hasBudget = () => attempts < input.maxPagesPerSite;
    const tryPage = async (url) => {
        if (!hasBudget() || tried.some((t) => sameAddress(t, url))) return null;
        attempts++;
        tried.push(url);
        await sleep(PAGE_DELAY_MS);
        try {
            const read = await readPage(url, entry, 0);
            if (tried.slice(0, -1).some((t) => sameAddress(t, read.url))) return null; // redirected to a page already read
            tried.push(read.url);
            entry.pagesFetched++;
            pages.push(read.page);
            return read;
        } catch {
            return null;
        }
    };

    // 2. The contact page: a clear link on the homepage, else a support link, else the usual addresses, else an about page.
    const candidates = rankContactCandidates(home.page.links, home.url);
    const strong = candidates.filter(isStrongCandidate);
    const inPage = candidates.find((c) => c.inPage);
    let contact = null; // { url, method, kind, page }
    const landed = (read, linked) => sanitizeUrl(read.url) ?? linked; // where the link led after redirects
    for (const c of strong.slice(0, 2)) {
        const read = await tryPage(c.url);
        if (read) {
            contact = { url: landed(read, c.url), method: 'link', kind: c.kind, page: read.page };
            break;
        }
    }
    if (!contact && strong.length > 0) contact = { url: strong[0].url, method: 'link', kind: strong[0].kind, page: null }; // linked, but not readable
    if (!contact && inPage) contact = { url: inPage.url, method: 'homepage', kind: 'contact', page: home.page };
    const weak = candidates.filter((c) => !c.inPage && !isStrongCandidate(c));
    const tryLinks = async (list) => {
        for (const c of list.slice(0, 2)) {
            const read = contact ? null : await tryPage(c.url);
            if (read) contact = { url: landed(read, c.url), method: 'link', kind: c.kind === 'notice' ? 'about' : c.kind, page: read.page };
        }
    };
    await tryLinks(weak.filter((c) => c.kind === 'contact' || c.kind === 'support')); // a support or help page, or a vaguer contact link
    if (!contact) {
        for (const url of guessUrls(home.url, home.page.lang)) {
            const read = await tryPage(url);
            if (read && read.page.looksLikeContact && new URL(read.url).pathname.replace(/\/$/, '') !== '') {
                contact = { url: sanitizeUrl(read.url), method: 'guess', kind: 'contact', page: read.page };
                break;
            }
        }
    }
    await tryLinks(weak.filter((c) => c.kind === 'about' || c.kind === 'notice')); // the weakest fallback
    if (!contact && home.page.form) contact = { url: entry.finalUrl, method: 'homepage', kind: 'contact', page: home.page };
    if (!contact && weak.length > 0) contact = { url: weak[0].url, method: 'link', kind: weak[0].kind === 'notice' ? 'about' : weak[0].kind, page: null }; // linked, but not read

    // 3. No role address yet: look at the legal notice, other contact pages and the about page, while the page budget lasts.
    const roleCount = () => pages.reduce((n, p) => n + p.emails.role.length, 0);
    for (const c of emailSourceCandidates(candidates)) {
        if (roleCount() > 0 || !hasBudget()) break;
        await tryPage(c.url);
    }

    const role = pages.flatMap((p) => p.emails.role);
    const otherHashes = new Set(pages.flatMap((p) => p.emails.otherHashes));
    const row = {
        website: target.source,
        finalUrl: entry.finalUrl,
        siteName: home.page.siteName,
        title: home.page.title,
        contactPageUrl: contact?.url ?? null,
        contactPageFound: contact !== null,
        contactPageMethod: contact?.method ?? null,
        contactPageKind: contact?.kind ?? null,
        hasContactForm: contact ? (contact.page ? contact.page.form !== null : null) : false,
        contactFormType: contact?.page?.form ?? null,
        socialProfiles: pickSocialProfiles(pages.flatMap((p) => p.socials)),
        emails: orderEmails(role, new URL(home.url).hostname),
        otherEmailsOmitted: otherHashes.size, // addresses not on the role allowlist: counted, never output
        pagesFetched: entry.pagesFetched,
        checkedAt: new Date().toISOString(),
    };

    const saved = await pushLimited([row]);
    if (saved === 0) {
        entry.status = 'not_saved';
        entry.message = 'The spending limit for this run was reached before this site could be saved. It was not charged.';
        stats.sitesSkipped++;
        return;
    }
    entry.contactPageMethod = row.contactPageMethod;
    stats.sitesOk++;
    const socialCount = Object.values(row.socialProfiles).filter(Boolean).length;
    log.info(`${target.host}: contact page ${row.contactPageUrl ?? 'not found'}${row.contactPageMethod ? ` (${row.contactPageMethod})` : ''}, `
        + `form ${row.hasContactForm === null ? 'unknown' : row.hasContactForm ? 'yes' : 'no'}, ${row.emails.length} role addresses, ${socialCount} social profiles, ${row.pagesFetched} pages.`);
}

// A fixed number of sites at a time; the pages of one site are read one after another.
let next = 0;
let inFlight = 0;
await Promise.all(Array.from({ length: Math.min(SITE_CONCURRENCY, input.targets.length) }, async () => {
    // A site is started only while the spending limit can still pay for it and for the sites already under way.
    while (next < input.targets.length && !limitReached && remainingBudget() > inFlight) {
        const target = input.targets[next++];
        inFlight++;
        try {
            await findContact(target);
        } catch (err) {
            const entry = report.find((r) => r.input === target.source);
            if (entry) Object.assign(entry, { status: 'error', message: `Unexpected error: ${err.message}` });
            stats.sitesFailed++;
            log.warning(`${target.host}: unexpected error: ${err.message}`);
        } finally {
            inFlight--;
        }
        await Actor.setStatusMessage(`${stats.sitesOk + stats.sitesFailed}/${stats.sites} sites done, ${stats.rows} rows`);
    }
}));
await pushing;
if (next < input.targets.length) {
    limitReached = true;
    stats.sitesSkipped += input.targets.length - next;
}

await Actor.setValue('SUMMARY', { ...stats, maxPagesPerSite: input.maxPagesPerSite, limitReached, siteReport: report });

if (limitReached) log.info('The spending limit for this run was reached; stopped early with the results saved so far.');
if (report.length > 0 && report.every((r) => r.status === 'timeout' || r.status === 'unreachable')) {
    await Actor.fail('None of the websites could be reached. Nothing was charged for results. Try again, or set a proxy in the input.');
}
const notes = [
    stats.sitesFailed ? `${stats.sitesFailed} sites not read` : null,
    limitReached ? 'spending limit reached' : null,
].filter(Boolean);
await Actor.exit(`Done: ${stats.rows} rows from ${stats.sites} websites${notes.length ? ` (${notes.join(', ')})` : ''}. Per-site details are in the SUMMARY record.`);
