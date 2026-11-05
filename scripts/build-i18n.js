#!/usr/bin/env node
/*
 * Builds pre-translated static pages for every language so search engines can
 * index them:  /es/, /es/sqlite-to-csv/, /ja/guides/sqlite-queries/ ...
 *
 *   - Reads the English pages (source of truth) and js/i18n/** translations.
 *   - Writes <lang>/<page>/index.html with translated text, <base href="/">,
 *     canonical + hreflang alternates, localized links and meta tags.
 *   - Adds hreflang alternates to the English pages (between markers).
 *   - Regenerates sitemap.xml with xhtml:link alternates.
 *
 * Usage:  npm i jsdom   (once, anywhere on NODE_PATH or in this folder)
 *         node scripts/build-i18n.js
 * Re-run it whenever English text or translations change.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const SITE = path.resolve(__dirname, "..", "sqliteviewer_fixed");
const ORIGIN = "https://sqliteviewer.codemasterlk.com";
const TODAY = new Date().toISOString().slice(0, 10);

// engine code, url folder, hreflang, og:locale, dir
const LANGS = [
    { code: "es", dir: "es", hl: "es", og: "es_ES" },
    { code: "zh", dir: "zh", hl: "zh-CN", og: "zh_CN" },
    { code: "zh-TW", dir: "zh-tw", hl: "zh-TW", og: "zh_TW" },
    { code: "hi", dir: "hi", hl: "hi", og: "hi_IN" },
    { code: "ar", dir: "ar", hl: "ar", og: "ar_AR", rtl: true },
    { code: "pt", dir: "pt", hl: "pt", og: "pt_BR" },
    { code: "id", dir: "id", hl: "id", og: "id_ID" },
    { code: "fr", dir: "fr", hl: "fr", og: "fr_FR" },
    { code: "ru", dir: "ru", hl: "ru", og: "ru_RU" },
    { code: "ja", dir: "ja", hl: "ja", og: "ja_JP" },
    { code: "de", dir: "de", hl: "de", og: "de_DE" },
    { code: "ko", dir: "ko", hl: "ko", og: "ko_KR" }
];

const PAGES = [
    "", "how-to-open-sqlite-file-online/", "sqlite-editor-online/", "sqlite-er-diagram-generator/",
    "sqlite-to-csv/", "sqlite-to-json/", "sqlite-to-excel/", "sqlite-to-sql-ddl/", "sqlite-to-dbml/",
    "sqlite-to-mermaid/", "sqlite-to-graphql/", "view-android-sqlite-database/",
    "sqlite-browser-without-installation/", "guides/sqlite-queries/", "privacy/",
    "guides/android-live-edit/", "guides/adb-bridge-setup/"
];
const PAGE_SET = new Set(PAGES);

const slugOf = (p) => p.replace(/\/$/, "").replace(/\//g, "-");
const read = (rel) => fs.readFileSync(path.join(SITE, rel), "utf8");

// ---------- load translations ----------
function evalFile(rel, I18N) {
    new Function("I18N", read(rel))(I18N);
}

const enSrc = read("js/i18n.js");
const EN = (function () {
    const a = enSrc.indexOf("var EN = {");
    const b = enSrc.indexOf("\n    };", a);
    return new Function("return " + enSrc.slice(a + "var EN = ".length, b + 6))();
}());

const MAIN = {};
LANGS.forEach((l) => {
    const store = {};
    const stub = { register: (c, d) => Object.assign(store, d) };
    evalFile("js/i18n/" + l.code + ".js", stub);
    evalFile("js/i18n/" + l.code + "-seo.js", stub);
    MAIN[l.code] = store;
});

let COMMON = {};
evalFile("js/i18n/pages/_common.js", { registerCommon: (d) => { COMMON = d; } });

const PAGE_DICTS = {};
PAGES.filter(Boolean).forEach((p) => {
    evalFile("js/i18n/pages/" + slugOf(p) + ".js", { registerPage: (s, d) => { PAGE_DICTS[s] = d; } });
});

// ---------- helpers ----------
const langBy = (code) => LANGS.find((l) => l.code === code);
const urlFor = (pagePath, l) => ORIGIN + "/" + (l ? l.dir + "/" : "") + pagePath;
const localPath = (pagePath, l) => "/" + (l ? l.dir + "/" : "") + pagePath;

function alternatesHtml(pagePath) {
    const lines = ['<link rel="alternate" hreflang="en" href="' + urlFor(pagePath) + '">'];
    LANGS.forEach((l) => lines.push('<link rel="alternate" hreflang="' + l.hl + '" href="' + urlFor(pagePath, l) + '">'));
    lines.push('<link rel="alternate" hreflang="x-default" href="' + urlFor(pagePath) + '">');
    return lines.join("\n    ");
}

const PAGE_SELECTOR = "h1,h2,h3,h4,p,li,summary,dt,dd,td,th,figcaption,.guide-callout,.guide-nav-links a,.guide-related a,a.guide-cta,.guide-footer";
function collectTargets(doc) {
    const out = [];
    doc.body.querySelectorAll(PAGE_SELECTOR).forEach((el) => {
        if (el.closest("pre")) return;
        if (el.querySelector(PAGE_SELECTOR)) return;
        if (!/[A-Za-z]/.test(el.textContent)) return;
        out.push(el);
    });
    return out;
}

function setMeta(doc, sel, attr, value) {
    const el = doc.querySelector(sel);
    if (el) el.setAttribute(attr, value);
}

// Rewrite relative URLs: resolve against the ORIGINAL page, localize page links.
function rewriteUrls(doc, pagePath, l) {
    const base = new URL(ORIGIN + "/" + pagePath);
    doc.querySelectorAll("[href],[src]").forEach((el) => {
        if (el.matches('link[rel="canonical"],link[rel="alternate"],base')) return;
        ["href", "src"].forEach((attr) => {
            const v = el.getAttribute(attr);
            if (!v || /^(#|mailto:|tel:|data:|javascript:|https?:|\/\/)/i.test(v)) return;
            const u = new URL(v, base);
            let p = u.pathname;
            const key = p.replace(/^\//, "");
            if (PAGE_SET.has(key)) p = localPath(key, l);
            el.setAttribute(attr, p + u.search + u.hash);
        });
    });
}

function finalize(doc, pagePath, l, title, desc) {
    const html = doc.documentElement;
    html.setAttribute("lang", l.hl);
    html.setAttribute("dir", l.rtl ? "rtl" : "ltr");
    html.setAttribute("data-i18n-static", l.code);
    html.setAttribute("data-i18n-path", pagePath);
    html.removeAttribute("data-i18n-page");

    rewriteUrls(doc, pagePath, l);

    // <base href="/"> so every remaining relative URL (scripts adding files, fetches) resolves from the root.
    doc.querySelectorAll("base").forEach((b) => b.remove());
    const base = doc.createElement("base");
    base.setAttribute("href", "/");
    const charset = doc.querySelector("meta[charset]");
    if (charset && charset.nextSibling) charset.parentNode.insertBefore(base, charset.nextSibling);
    else doc.head.insertBefore(base, doc.head.firstChild);

    doc.title = title;
    setMeta(doc, 'meta[name="description"]', "content", desc);
    setMeta(doc, 'meta[property="og:title"]', "content", title);
    setMeta(doc, 'meta[property="og:description"]', "content", desc);
    setMeta(doc, 'meta[name="twitter:title"]', "content", title);
    setMeta(doc, 'meta[name="twitter:description"]', "content", desc);
    setMeta(doc, 'meta[property="og:url"]', "content", urlFor(pagePath, l));
    if (!doc.querySelector('meta[property="og:locale"]')) {
        const m = doc.createElement("meta");
        m.setAttribute("property", "og:locale");
        doc.head.appendChild(m);
    }
    setMeta(doc, 'meta[property="og:locale"]', "content", l.og);

    // canonical + alternates
    doc.querySelectorAll('link[rel="canonical"],link[rel="alternate"][hreflang]').forEach((e) => e.remove());
    const frag = doc.createElement("template");
    frag.innerHTML = '<link rel="canonical" href="' + urlFor(pagePath, l) + '">\n    ' + alternatesHtml(pagePath) + "\n";
    doc.head.appendChild(frag.content);

    // cache-bust the engine
    doc.querySelectorAll('script[src*="i18n.js"]').forEach((s) => {
        s.setAttribute("src", s.getAttribute("src").replace(/\?v=\d+/, "?v=4"));
    });
}

function writePage(pagePath, l, doc) {
    const out = path.join(SITE, l.dir, pagePath, "index.html");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, "<!DOCTYPE html>\n" + doc.documentElement.outerHTML + "\n");
}

// ---------- main page ----------
function buildMain(l) {
    const dict = MAIN[l.code];
    const t = (k) => (dict[k] !== undefined ? dict[k] : EN[k]);
    const dom = new JSDOM(read("index.html"));
    const doc = dom.window.document;
    const str = (v) => (typeof v === "object" ? (v.other !== undefined ? v.other : v.one) : v);

    doc.querySelectorAll("[data-i18n]").forEach((e) => { e.textContent = str(t(e.getAttribute("data-i18n"))); });
    doc.querySelectorAll("[data-i18n-html]").forEach((e) => { e.innerHTML = str(t(e.getAttribute("data-i18n-html"))); });
    doc.querySelectorAll("[data-i18n-title]").forEach((e) => e.setAttribute("title", str(t(e.getAttribute("data-i18n-title")))));
    doc.querySelectorAll("[data-i18n-placeholder]").forEach((e) => e.setAttribute("placeholder", str(t(e.getAttribute("data-i18n-placeholder")))));
    doc.querySelectorAll("[data-i18n-aria]").forEach((e) => e.setAttribute("aria-label", str(t(e.getAttribute("data-i18n-aria")))));

    // FAQ structured data in the page language
    doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
        try {
            const data = JSON.parse(s.textContent);
            const strip = (x) => x.replace(/<[^>]+>/g, "");
            data.forEach((o) => {
                if (o["@type"] === "FAQPage") {
                    o.mainEntity.forEach((q, i) => {
                        q.name = strip(str(t("seo.q" + (i + 1))));
                        q.acceptedAnswer.text = strip(str(t("seo.a" + (i + 1))));
                    });
                }
                if (o["@type"] === "SoftwareApplication") o.description = str(t("page.desc"));
                if (o.url) o.url = urlFor("", l);
            });
            s.textContent = JSON.stringify(data);
        } catch (e) { /* leave as is */ }
    });

    finalize(doc, "", l, str(t("page.title")), str(t("page.desc")));
    writePage("", l, doc);
}

// ---------- tutorial pages ----------
function buildGuide(pagePath, l) {
    const slug = slugOf(pagePath);
    const dom = new JSDOM(read(pagePath + "index.html"));
    const doc = dom.window.document;
    const els = collectTargets(doc);
    const list = PAGE_DICTS[slug] && PAGE_DICTS[slug][l.code];
    if (!list) throw new Error("missing translations " + slug + " " + l.code);
    if (list.length !== els.length + 2) throw new Error(slug + " " + l.code + ": expected " + (els.length + 2) + " strings, got " + list.length);

    const origs = [doc.title, ""].concat(els.map((e) => e.innerHTML));
    const brand = doc.querySelector(".guide-brand");
    const root = brand ? brand.getAttribute("href") : "../";
    const resolved = list.map((v, i) => {
        if (v === 0) {
            const o = origs[i];
            const key = /^© 2026/.test(o) ? "@footer" : o;
            v = (COMMON[l.code] && COMMON[l.code][key]) || o;
        }
        return v.split("{root}").join(root);
    });

    els.forEach((el, i) => { el.innerHTML = resolved[i + 2]; });
    finalize(doc, pagePath, l, resolved[0], resolved[1]);
    writePage(pagePath, l, doc);
}

// ---------- English pages: alternates + path marker, in place ----------
const MARK_A = "<!--i18n-alternates-->";
const MARK_B = "<!--/i18n-alternates-->";
function updateEnglish(pagePath) {
    const rel = pagePath + "index.html";
    let s = read(rel);
    const block = MARK_A + "\n    " + alternatesHtml(pagePath) + "\n    " + MARK_B;
    const re = new RegExp(MARK_A.replace(/[/]/g, "\\/") + "[\\s\\S]*?" + MARK_B.replace(/[/]/g, "\\/"));
    if (re.test(s)) s = s.replace(re, () => block);
    else s = s.replace(/<\/head>/i, () => "    " + block + "\n</head>");
    s = s.replace(/<html([^>]*)>/i, (m, attrs) => {
        attrs = attrs.replace(/\s*data-i18n-path="[^"]*"/, "");
        return '<html' + attrs + ' data-i18n-path="' + pagePath + '">';
    });
    s = s.replace(/js\/i18n\.js\?v=\d+/g, "js/i18n.js?v=4");
    fs.writeFileSync(path.join(SITE, rel), s);
}

// ---------- sitemap ----------
function buildSitemap() {
    const old = read("sitemap.xml");
    const lastmod = (p) => {
        const m = old.match(new RegExp("<loc>" + (ORIGIN + "/" + p).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + "</loc><lastmod>([^<]+)</lastmod>"));
        return m ? m[1] : TODAY;
    };
    const rows = [];
    PAGES.forEach((p) => {
        const lm = lastmod(p);
        const alts = ['<xhtml:link rel="alternate" hreflang="en" href="' + urlFor(p) + '"/>']
            .concat(LANGS.map((l) => '<xhtml:link rel="alternate" hreflang="' + l.hl + '" href="' + urlFor(p, l) + '"/>'))
            .concat(['<xhtml:link rel="alternate" hreflang="x-default" href="' + urlFor(p) + '"/>']).join("");
        [null].concat(LANGS).forEach((l) => {
            rows.push("  <url><loc>" + urlFor(p, l) + "</loc><lastmod>" + lm + "</lastmod>" + alts + "</url>");
        });
    });
    fs.writeFileSync(path.join(SITE, "sitemap.xml"),
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
        rows.join("\n") + "\n</urlset>\n");
}

// ---------- run ----------
LANGS.forEach((l) => fs.rmSync(path.join(SITE, l.dir), { recursive: true, force: true }));
let count = 0;
LANGS.forEach((l) => {
    PAGES.forEach((p) => {
        if (p === "") buildMain(l); else buildGuide(p, l);
        count++;
    });
});
PAGES.forEach(updateEnglish);
buildSitemap();
console.log("Generated " + count + " pages in " + LANGS.length + " languages; sitemap.xml updated.");
