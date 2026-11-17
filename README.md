# Contact Page Finder: Forms, Socials, Role Emails Only

Give Contact Page Finder a list of websites and get back, for each one: **its contact page, whether that page has a
contact form, its social profiles, and its role-based email addresses** such as `info@`, `sales@`
and `support@`. Personal addresses (`john.smith@`) are never returned: that is a design rule, not a
setting.

- **Contact page:** found from the homepage's links by address and link text in English, German,
  French, Spanish, Italian, Portuguese, Dutch, Polish and the Nordic languages (`contact`,
  `kontakt`, `contacto`, `contatti`, `nous-contacter`, `get-in-touch`...). If there is no link, the
  usual addresses (`/contact`, `/contact-us`, `/kontakt`) are tried. Each row says how the page was
  found.
- **Contact form:** `true` when the contact page carries a form to write a message with. Search
  boxes, logins and newsletter sign-ups do not count.
- **Social profiles:** LinkedIn, X (Twitter), Facebook, Instagram, YouTube, TikTok and GitHub, as
  clean profile addresses. Share buttons and single posts are skipped.
- **Role addresses only:** from `mailto:` links, page text, structured data, Cloudflare-protected
  addresses and simple spellings like `info [at] site [dot] com`.
- **Many websites per run:** up to 1,000, read 8 at a time. Plain HTTP, no browser. In our test
  13 websites, two pages each, took under 4 seconds.

Open source (MIT). Written in Node.js on the Apify SDK; it runs on your own machine without an Apify account.

## Run it locally

Needs Node.js 20 or later.

```
git clone https://github.com/sebdata-tools/contact-page-finder.git
cd contact-page-finder
npm install
node test/run_local.mjs @input.json
```

`input.json` is a file you write; the fields are under "Input example" below. `run_local.mjs` runs
`src/main.js` with local storage, prints a summary and the first rows, and leaves all rows in
`storage/items.json` (one file per row is in `storage/datasets/default/`). Each run wipes `storage/` first.

Where the sections below mention a price or what is charged, that applies to the hosted version only:
run locally, nothing is charged.

## Input example

```json
{
    "websites": ["https://plausible.io", "kingarthurbaking.com", "https://www.manufactum.de"],
    "maxPagesPerSite": 4
}
```

| Field | What it does | Default |
|---|---|---|
| `websites` | Domains or addresses. Up to 1,000. Required. | |
| `maxPagesPerSite` | Pages read per website (1 to 8): homepage, contact page, then the legal notice or about page if no role address was found yet. | `4` |
| `proxyConfiguration` | Optional proxy. Usually not needed. | none |

## Output example

One row per website:

```json
{
    "website": "kingarthurbaking.com",
    "finalUrl": "https://www.kingarthurbaking.com/",
    "siteName": "King Arthur Baking",
    "title": "King Arthur Baking - Try it Once, Trust it Always",
    "contactPageUrl": "https://www.kingarthurbaking.com/contact",
    "contactPageFound": true,
    "contactPageMethod": "link",
    "contactPageKind": "contact",
    "hasContactForm": false,
    "contactFormType": null,
    "socialProfiles": {
        "linkedin": "https://www.linkedin.com/company/kingarthurbakingcompany",
        "twitter": null,
        "facebook": "https://www.facebook.com/kingarthurbaking",
        "instagram": "https://www.instagram.com/kingarthurbaking",
        "youtube": "https://www.youtube.com/KingArthurBakingCompany",
        "tiktok": "https://www.tiktok.com/@kingarthurbakingcompany",
        "github": null
    },
    "emails": ["customercare@kingarthurbaking.com"],
    "otherEmailsOmitted": 2,
    "pagesFetched": 2,
    "checkedAt": "2026-11-14T07:35:16.088Z"
}
```

| Field | Meaning |
|---|---|
| `contactPageMethod` | `link`: linked from the homepage. `guess`: found at `/contact` or a similar usual address. `homepage`: the contact section or form is on the homepage itself. `null`: none found. |
| `contactPageKind` | `contact`, or the weaker fallbacks `support` (a help page) and `about` (an about page or legal notice). |
| `hasContactForm` | `true`, `false`, or `null` when the contact page was linked but could not be read. |
| `contactFormType` | `html` (a form in the page) or `embed` (HubSpot, Typeform, Jotform, Google Forms, Tally, Paperform and similar, loaded into the page). |
| `emails` | Role addresses, the website's own domain first, at most 20. |
| `otherEmailsOmitted` | How many other addresses were seen and left out (see below). |

Export the dataset as JSON, CSV or Excel, or read it through the Apify API.

## What it deliberately does not return

- **Personal email addresses.** An address is returned only when the part before the `@` is exactly
  one of about 260 role names (`info`, `contact`, `hello`, `sales`, `support`, `press`, `careers`,
  `billing`, `kontakt`, `presse`, `ventas`, `contatti`...). Everything else, `john.smith@`,
  `j.smith@`, `anna@`, is never written to the dataset, the run summary or the log. You get only the
  count, in `otherEmailsOmitted`. The reason: a named person's address is personal data, and this
  Actor is built for finding how to reach an organisation, not for collecting people.
  The rule errs on the safe side: an unusual department address that is not on the list
  (`bookclubs@`, `info.export@`) is left out and counted too.
- **Personal LinkedIn profiles.** Only company, school and showcase pages; never `/in/` profiles.
- **Phone numbers.** Not collected.
- **Names of people**, job titles or anything else about individuals.

## Limits

- **No browser.** Pages are read as the server sends them. A contact form or a link that only
  appears after JavaScript runs is not seen: `hasContactForm: false` means "no form in the page's
  HTML". Websites that are a pure JavaScript app give a row with little in it.
- **Some websites block automated access** (HTTP 403 or a bot-check page): in our test of 40
  well-known websites, 13 did. They are reported, not charged. A proxy in the input may help.
- **At most `maxPagesPerSite` pages per website** are read, one after another with a short pause;
  only the homepage is retried on errors. The Actor says honestly who it is in its User-Agent.
  At most 2 MB of each page is read.
- **The contact page is the best candidate, not a guarantee.** When a website has no contact page,
  a support or about page is returned and marked as such in `contactPageKind`.
- **Social profiles are the ones the website links to most.** A website that links to someone
  else's profile more often than its own can give a wrong one.
- **Role addresses of other organisations** shown on the website (a partner, an agency) can appear
  after the website's own.

## Good to know

- **Websites that cannot be read** are listed in the log and in the run's `SUMMARY` record
  (key-value store) with the reason: the domain does not exist, no answer in time, access blocked,
  an error page, or not a web page. The rest of the run carries on.
- **Spending limit:** if you set a maximum charge for the run, the Actor stops starting new websites
  when it is reached and keeps what it has saved.
- Only public pages are read: no login, and no form is ever submitted.

## Typical uses

Finding the right way to reach a company for partnerships, press or support, enriching a list of
company websites with contact pages and social profiles, checking which websites of a list have a
contact form, giving an LLM or agent a clean "how to contact this organisation" record.

## Tests

`src/lib.js` holds the pure logic (input checks, URL building, parsing); `src/main.js` holds the network
and storage code. The unit tests in `test/lib.test.js` run `lib.js` against saved answers of the live
sources. Those files are copies of third-party pages and API answers and are **not included in this
repository**, so `npm test` says so and skips. To run them, save your own captures under `test/fixtures/`
with the file names the test reads. The live check is `node test/run_local.mjs @input.json`.

## Hosted version

To run it in the cloud, on a schedule or through an API, without installing anything: [Contact Page Finder: Forms, Socials, Role Emails Only on Apify](https://apify.com/sebdata/contact-page-finder) (paid per result).

## Who made this

This tool and its code were written by an AI agent (Anthropic's Claude), under a human account owner. Problems and wrong results: open an issue. MIT licence, no warranty.
