#!/usr/bin/env node
// Commit Metro — self-hosted GitHub profile generator.
// "Every line is a language, every stop a project."
//
// Pulls data from the GitHub GraphQL API (public + private repos when a
// personal access token is provided via METRO_TOKEN) and renders a set of
// SVG cards into ./metro that README.md embeds.
//
// Zero dependencies — requires Node 18+ (global fetch).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.join(ROOT, "metro");

const config = JSON.parse(await fs.readFile(path.join(ROOT, "metro.config.json"), "utf8"));
const TOKEN = process.env.METRO_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!TOKEN) {
  console.error("✖ Set METRO_TOKEN (PAT with repo + read:user) to include private data.");
  process.exit(1);
}
const LOGIN = config.username;
const PRIVACY = config.privacy || "mask"; // show | mask | hide

// ───────────────────────────── theme ─────────────────────────────
const T = {
  bg: "#0d1117",
  card: "#10141b",
  border: "#262c36",
  accent: "#e8552d",
  text: "#f0f3f6",
  sub: "#c9d1d9",
  muted: "#8b949e",
  track: "#30363d",
  green: "#3fb950",
  sans: "'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif",
  mono: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, 'DejaVu Sans Mono', monospace",
};
const HEAT = ["#1b2029", "#5c2615", "#94361a", "#d24f2a", "#f3906e"];

const ABBR = {
  JavaScript: "JS", TypeScript: "TS", Python: "PY", Go: "GO", Shell: "SH", "C++": "C++",
  C: "C", "C#": "C#", Java: "JV", Kotlin: "KT", Rust: "RS", HTML: "HT", CSS: "CSS",
  SCSS: "SC", PHP: "PHP", Ruby: "RB", Dart: "DT", Swift: "SW", Vue: "VU", Svelte: "SV",
  HCL: "HCL", Dockerfile: "DK", Lua: "LUA", "Jupyter Notebook": "NB", PowerShell: "PS",
  Makefile: "MK", Nix: "NIX", Zig: "ZIG", Haskell: "HS", Elixir: "EX", Scala: "SC",
  Batchfile: "BAT", PLSQL: "SQL", TSQL: "SQL", Assembly: "ASM", Blade: "BL", Astro: "AS",
};
const abbr = (l) => ABBR[l] || (l || "?").slice(0, 2).toUpperCase();

// ───────────────────────────── helpers ─────────────────────────────
const esc = (s = "") =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const trunc = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)).trimEnd() + "…" : s);
function wrap(text, maxChars, maxLines) {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars) {
      if (cur) lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    } else cur = (cur + " " + w).trim();
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  const used = lines.join(" ").length;
  if (used < String(text || "").replace(/\s+/g, " ").trim().length && lines.length) {
    lines[lines.length - 1] = trunc(lines[lines.length - 1] + "…", maxChars).replace(/…+$/, "") + "…";
  }
  return lines.slice(0, maxLines).map((l) => trunc(l, maxChars + 1));
}
function luminance(hex) {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ink = (hex) => (luminance(hex) > 0.55 ? "#0d1117" : "#ffffff");
const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n));

function svg(w, h, body, title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
${body}
</svg>
`;
}

// Card frame w/ orange top rail, as in the reference design.
function card(w, h, label, inner) {
  return `<defs><clipPath id="cc"><rect width="${w}" height="${h}" rx="12"/></clipPath></defs>
<g clip-path="url(#cc)">
  <rect width="${w}" height="${h}" fill="${T.card}"/>
  <rect width="${w}" height="5" fill="${T.accent}"/>
</g>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="12" fill="none" stroke="${T.border}"/>
${badge(24, 30, label)}
${inner}`;
}
function badge(x, y, label) {
  return `<g transform="translate(${x},${y})">
  <circle cx="7" cy="0" r="7" fill="${T.accent}"/>
  <text x="7" y="3.5" text-anchor="middle" font-family="${T.sans}" font-size="9" font-weight="800" fill="#fff">M</text>
  <text x="21" y="4" font-family="${T.sans}" font-size="11" font-weight="700" fill="${T.text}">${esc(label)}</text>
</g>`;
}
function langChip(x, y, lang, color, size = 14) {
  const a = abbr(lang);
  const fs = a.length > 2 ? size * 0.42 : size * 0.5;
  return `<g transform="translate(${x},${y})">
  <rect width="${size}" height="${size}" rx="${size * 0.22}" fill="${color}"/>
  <text x="${size / 2}" y="${size / 2 + fs * 0.36}" text-anchor="middle" font-family="${T.mono}" font-size="${fs}" font-weight="800" fill="${ink(color)}">${esc(a)}</text>
</g>`;
}

// ───────────────────────────── data ─────────────────────────────
async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json", "User-Agent": "commit-metro" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors || json, null, 2));
  return json.data;
}

async function fetchAll() {
  const yearStart = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)).toISOString();
  const head = await gql(
    `query($login:String!, $yearStart:DateTime!){
      viewer { login }
      user(login:$login){
        login name bio location company websiteUrl avatarUrl(size:200)
        followers { totalCount }
        calendar: contributionsCollection {
          restrictedContributionsCount
          contributionCalendar { totalContributions weeks { contributionDays { date contributionCount contributionLevel } } }
        }
        year: contributionsCollection(from:$yearStart) {
          totalCommitContributions restrictedContributionsCount
          contributionCalendar { totalContributions }
        }
      }
    }`,
    { login: LOGIN, yearStart }
  );

  // Paginate repositories. `viewer.repositories` sees private repos when the
  // token belongs to the user; `user.repositories` is used as a fallback.
  const isSelf = head.viewer.login.toLowerCase() === LOGIN.toLowerCase();
  const repos = [];
  let after = null;
  do {
    const q = `query(${isSelf ? "" : "$login:String!, "}$after:String){
      ${isSelf ? "owner: viewer" : "owner: user(login:$login)"} {
        repositories(first:100, after:$after, ownerAffiliations:OWNER, orderBy:{field:PUSHED_AT, direction:DESC}) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            name url description isPrivate isFork isArchived stargazerCount forkCount pushedAt
            primaryLanguage { name color }
            languages(first:20, orderBy:{field:SIZE, direction:DESC}) { edges { size node { name color } } }
          }
        }
      }
    }`;
    const d = await gql(q, isSelf ? { after } : { login: LOGIN, after });
    const r = d.owner.repositories;
    repos.push(...r.nodes);
    after = r.pageInfo.hasNextPage ? r.pageInfo.endCursor : null;
  } while (after);

  if (!isSelf) console.warn(`⚠ Token belongs to ${head.viewer.login}, not ${LOGIN} — only public data is visible.`);
  return { user: head.user, repos };
}

// ───────────────────────────── processing ─────────────────────────────
function process_(data) {
  const { user, repos: all } = data;
  const exclude = new Set((config.excludeRepos || []).map((s) => s.toLowerCase()));
  const exLang = new Set(config.excludeLanguages || []);
  const repos = all.filter((r) => (config.includeForks || !r.isFork) && !exclude.has(r.name.toLowerCase()));

  // Display-safe view of a repo, honouring privacy mode.
  let privN = 0;
  const view = (r) => {
    if (!r.isPrivate || PRIVACY === "show") return { ...r, label: r.name, desc: r.description, link: r.url };
    privN += 1;
    return { ...r, label: `🔒 private-${String(privN).padStart(2, "0")}`, desc: "Private project — details classified.", link: `https://github.com/${user.login}` };
  };
  const visible = PRIVACY === "hide" ? repos.filter((r) => !r.isPrivate) : repos;
  const viewed = new Map(visible.map((r) => [r.name, view(r)]));

  // Languages by bytes across ALL owned repos (public + private).
  const bytes = new Map();
  const colors = new Map();
  for (const r of repos)
    for (const e of r.languages.edges) {
      colors.set(e.node.name, e.node.color || "#8b949e");
      if (exLang.has(e.node.name)) continue;
      bytes.set(e.node.name, (bytes.get(e.node.name) || 0) + e.size);
    }
  const totalBytes = [...bytes.values()].reduce((a, b) => a + b, 0) || 1;
  const langBars = [...bytes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, config.maxLanguagesInBars || 5)
    .map(([name, b]) => ({ name, color: colors.get(name), pct: (b / totalBytes) * 100 }));

  // Metro lines: languages ranked by number of (visible) projects.
  const byLang = new Map();
  for (const r of visible) {
    const l = r.primaryLanguage?.name;
    if (!l || exLang.has(l)) continue;
    colors.set(l, r.primaryLanguage.color || colors.get(l) || "#8b949e");
    if (!byLang.has(l)) byLang.set(l, []);
    byLang.get(l).push(viewed.get(r.name));
  }
  const lines = [...byLang.entries()]
    .sort((a, b) => b[1].length - a[1].length || (bytes.get(b[0]) || 0) - (bytes.get(a[0]) || 0))
    .slice(0, config.maxLines || 5)
    .map(([name, rs]) => ({ name, color: colors.get(name), repos: rs }));

  // Stations (featured cards).
  const n = config.stationCount || 4;
  let stations = (config.stations || []).map((s) => viewed.get(visible.find((r) => r.name.toLowerCase() === s.toLowerCase())?.name)).filter(Boolean);
  for (const r of visible) {
    if (stations.length >= n) break;
    if (!stations.find((s) => s.name === r.name) && !r.isArchived) stations.push(viewed.get(r.name));
  }
  stations = stations.slice(0, n);

  // Timetable: last 26 weeks + streaks.
  const days = user.calendar.contributionCalendar.weeks.flatMap((w) => w.contributionDays);
  const today = new Date().toISOString().slice(0, 10);
  let longest = 0, run = 0;
  for (const d of days) {
    run = d.contributionCount > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    if (d.contributionCount > 0) current++;
    else if (d.date === today && current === 0) continue; // today not over yet
    else break;
  }
  const weeks = user.calendar.contributionCalendar.weeks.slice(-26);

  const privCount = all.filter((r) => r.isPrivate && !r.isFork).length;
  const ownCount = all.filter((r) => !r.isFork).length;

  return {
    user, lines, langBars, stations, weeks, colors,
    stats: {
      current, longest,
      yearTotal: user.year.contributionCalendar.totalContributions,
      yearPrivate: user.year.restrictedContributionsCount,
      repoTotal: ownCount, repoPrivate: privCount,
    },
  };
}

// ───────────────────────────── renderers ─────────────────────────────
async function avatarData(url) {
  try {
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${res.headers.get("content-type") || "image/png"};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

function renderMap(m, avatar) {
  const W = 840, H = 450, cx = 420, cy = 268;
  const L = m.lines;
  const n = L.length;
  // Vertical levels for arms (top → bottom), keeping a gap around the hub.
  const levels = (() => {
    const top = Math.ceil(n / 2), bot = n - top;
    const step = 40, gap = 50;
    const up = Array.from({ length: top }, (_, i) => -(gap + step * (top - 1 - i)));
    const down = Array.from({ length: bot }, (_, i) => gap + step * i);
    return [...up, ...down];
  })();
  // Right side order swaps neighbours so lines visibly cross at the hub.
  const rightOrder = L.map((_, i) => (i ^ 1) < n ? i ^ 1 : i);

  const tracks = [], stops = [], labels = [], pills = [], trains = [], defs = [];
  const pillX = 40;

  L.forEach((line, i) => {
    const pillW = Math.max(70, line.name.length * 7 + 34);
    const leftEnd = pillX + pillW;
    const dyL = levels[i];
    const dyR = levels[rightOrder[i]];
    const bendL = cx - (52 + Math.abs(dyL) * 0.95);
    const bendR = cx + (52 + Math.abs(dyR) * 0.95);
    const yL = cy + dyL, yR = cy + dyR;
    const rightEnd = W - 40;

    const pathL = `M${leftEnd},${yL} L${bendL},${yL} L${cx},${cy}`;
    const pathR = `M${cx},${cy} L${bendR},${yR} L${rightEnd},${yR}`;
    tracks.push(`<path d="${pathL}" fill="none" stroke="${line.color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`);
    tracks.push(`<path d="${pathR}" fill="none" stroke="${line.color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`);

    // Terminus pill (left) + buffer stop (right).
    pills.push(`<g transform="translate(${pillX},${yL - 10})">
  <rect width="${pillW}" height="20" rx="10" fill="${line.color}"/>
  <rect x="5" y="3" width="14" height="14" rx="3" fill="${ink(line.color)}"/>
  <text x="12" y="${abbr(line.name).length > 2 ? 12.6 : 13.2}" text-anchor="middle" font-family="${T.mono}" font-size="${abbr(line.name).length > 2 ? 5.8 : 7}" font-weight="800" fill="${line.color}">${esc(abbr(line.name))}</text>
  <text x="${(pillW + 20) / 2 + 2}" y="14" text-anchor="middle" font-family="${T.mono}" font-size="9.5" font-weight="800" letter-spacing="0.6" fill="${ink(line.color)}">${esc(line.name.toUpperCase())}</text>
</g>`);
    pills.push(`<rect x="${rightEnd - 3}" y="${yR - 9}" width="6" height="18" rx="3" fill="${line.color}"/>`);

    // Split projects across both arms.
    const segL = [leftEnd + 34, bendL - 26];
    const segR = [bendR + 30, rightEnd - 30];
    const capL = Math.max(0, Math.floor((segL[1] - segL[0]) / 62) + 1);
    const capR = Math.max(0, Math.floor((segR[1] - segR[0]) / 90) + 1);
    const left = [], right = [];
    line.repos.forEach((r, k) => {
      if (k % 2 === 0 && left.length < capL) left.push(r);
      else if (right.length < capR) right.push(r);
      else if (left.length < capL) left.push(r);
    });
    const place = (arr, [a, b], y, side) => {
      if (!arr.length) return;
      const span = b - a;
      const xs = arr.length === 1 ? [side === "L" ? b : (a + b) / 2] : arr.map((_, k) => (side === "L" ? b - (span * k) / (arr.length - 1) : a + (span * k) / (arr.length - 1)));
      const spacing = arr.length > 1 ? span / (arr.length - 1) : 160;
      arr.forEach((r, k) => {
        const x = xs[k];
        const above = dyL < 0 || side === "R" ? (k % 2 === 0 || spacing > 95) : !(k % 2 === 0 || spacing > 95);
        const ly = above ? y - 13 : y + 22;
        const maxChars = Math.max(6, Math.floor(Math.min(spacing * (spacing > 95 ? 1 : 2), 150) / 6.3));
        const text = trunc(r.label, maxChars);
        const half = (text.length * 6.2) / 2;
        const tx = Math.min(Math.max(x, half + 14), W - half - 14);
        stops.push(`<a xlink:href="${esc(r.link)}" target="_blank"><circle cx="${x}" cy="${y}" r="6.5" fill="${T.bg}" stroke="#ffffff" stroke-width="3"><title>${esc(r.label)}</title></circle></a>`);
        labels.push(`<text x="${tx.toFixed(1)}" y="${ly}" text-anchor="middle" font-family="${T.sans}" font-size="10.5" font-weight="700" fill="${T.text}" stroke="${T.bg}" stroke-width="3" paint-order="stroke">${esc(text)}</text>`);
      });
    };
    place(left, segL, yL, "L");
    place(right, segR, yR, "R");

    // Animated trains shuttling along each arm.
    const durL = (7 + ((i * 37) % 5)).toFixed(1), durR = (8 + ((i * 53) % 5)).toFixed(1);
    defs.push(`<path id="tl${i}" d="M${leftEnd + 8},${yL} L${bendL},${yL} L${cx},${cy}"/>`, `<path id="tr${i}" d="M${cx},${cy} L${bendR},${yR} L${rightEnd - 10},${yR}"/>`);
    for (const [id, dur, begin] of [[`tl${i}`, durL, `-${i * 1.3}s`], [`tr${i}`, durR, `-${i * 2.1}s`]]) {
      trains.push(`<g opacity="0"><set attributeName="opacity" to="1" begin="0s"/><rect x="-11" y="-5" width="22" height="10" rx="4" fill="#ffffff" stroke="${line.color}" stroke-width="2"/>
  <animateMotion dur="${dur}s" begin="${begin}" repeatCount="indefinite" rotate="auto" keyPoints="0;1;0" keyTimes="0;0.5;1" calcMode="linear"><mpath xlink:href="#${id}"/></animateMotion></g>`);
    }
  });

  const hub = `<g>
  <circle cx="${cx}" cy="${cy}" r="31" fill="${T.bg}" stroke="#ffffff" stroke-width="3.5"/>
  ${avatar ? `<image xlink:href="${avatar}" x="${cx - 26}" y="${cy - 26}" width="52" height="52" clip-path="url(#hubclip)" preserveAspectRatio="xMidYMid slice"/>` : `<text x="${cx}" y="${cy + 6}" text-anchor="middle" font-family="${T.sans}" font-size="18" font-weight="800" fill="#fff">${esc(m.user.login[0].toUpperCase())}</text>`}
  <text x="${cx}" y="${cy + 50}" text-anchor="middle" font-family="${T.sans}" font-size="11.5" font-weight="800" fill="#ffffff" stroke="${T.bg}" stroke-width="4" paint-order="stroke">@${esc(m.user.login.toLowerCase())}</text>
</g>`;

  const body = `<defs>
  <clipPath id="hubclip"><circle cx="${cx}" cy="${cy}" r="26"/></clipPath>
  ${defs.join("\n  ")}
</defs>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="16" fill="${T.bg}" stroke="${T.border}"/>
<text x="32" y="42" font-family="${T.mono}" font-size="10.5" font-weight="700" letter-spacing="2" fill="${T.green}">COMMIT METRO</text>
<text x="32" y="70" font-family="${T.sans}" font-size="22" font-weight="800" fill="${T.text}">Every line is a language, every stop a project</text>
${tracks.join("\n")}
${trains.join("\n")}
${pills.join("\n")}
${stops.join("\n")}
${labels.join("\n")}
${hub}
<text x="${W - 24}" y="${H - 18}" text-anchor="end" font-family="${T.mono}" font-size="9" fill="${T.muted}">${m.stats.repoTotal} projects · ${m.stats.repoPrivate} private · ${L.length} lines</text>`;
  return svg(W, H, body, "Commit Metro map");
}

function renderInterchange(m, avatar) {
  const W = 840, H = 178;
  const u = m.user;
  const bio = wrap(u.bio || "", 58, 2);
  const meta = [u.location, u.company, `${u.followers.totalCount} followers`, `${m.stats.repoTotal} repositories (${m.stats.repoPrivate} private)`].filter(Boolean).join("  ·  ");
  const inner = `
<text x="24" y="80" font-family="${T.sans}" font-size="27" font-weight="800" fill="${T.text}">${esc(trunc(u.name || u.login, 34))}</text>
${bio.map((l, i) => `<text x="24" y="${110 + i * 21}" font-family="${T.sans}" font-size="14.5" fill="${T.sub}">${esc(l)}</text>`).join("\n")}
<text x="24" y="${bio.length ? 110 + bio.length * 21 + 4 : 112}" font-family="${T.mono}" font-size="10.5" fill="${T.muted}">${esc(trunc(meta, 92))}</text>
<defs><clipPath id="av"><circle cx="${W - 90}" cy="${H / 2 + 4}" r="50"/></clipPath></defs>
<circle cx="${W - 90}" cy="${H / 2 + 4}" r="54" fill="${T.accent}"/>
${avatar ? `<image xlink:href="${avatar}" x="${W - 140}" y="${H / 2 - 46}" width="100" height="100" clip-path="url(#av)" preserveAspectRatio="xMidYMid slice"/>` : ""}`;
  return svg(W, H, card(W, H, "Interchange", inner), `${u.name || u.login} — Interchange`);
}

function renderStation(r, idx, colors) {
  const W = 412, H = 150;
  const lang = r.primaryLanguage?.name;
  const color = lang ? colors.get(lang) || r.primaryLanguage.color || "#8b949e" : "#8b949e";
  const desc = wrap(r.desc || "A project in progress.", 50, 2);
  const icon = lang
    ? `<circle cx="${W - 38}" cy="34" r="15" fill="${color}"/><text x="${W - 38}" y="${34 + 4}" text-anchor="middle" font-family="${T.mono}" font-size="${abbr(lang).length > 2 ? 9 : 11}" font-weight="800" fill="${ink(color)}">${esc(abbr(lang))}</text>`
    : `<circle cx="${W - 38}" cy="34" r="15" fill="#6e7681"/><text x="${W - 38}" y="38.5" text-anchor="middle" font-family="${T.sans}" font-size="13" font-weight="800" fill="#fff">×</text>`;
  const lock = r.isPrivate ? `<g transform="translate(${W - 100},26)"><rect width="46" height="16" rx="8" fill="none" stroke="${T.muted}"/><text x="23" y="11.5" text-anchor="middle" font-family="${T.mono}" font-size="8.5" font-weight="700" fill="${T.muted}">PRIVATE</text></g>` : "";
  let fx = 24;
  const foot = [];
  foot.push(`<text x="${fx}" y="128" font-family="${T.mono}" font-size="10.5" fill="${T.muted}">★ ${fmt(r.stargazerCount)}</text>`);
  fx += 34 + String(fmt(r.stargazerCount)).length * 6;
  foot.push(`<text x="${fx}" y="128" font-family="${T.mono}" font-size="10.5" fill="${T.muted}">⑂ ${fmt(r.forkCount)}</text>`);
  fx += 34 + String(fmt(r.forkCount)).length * 6;
  if (lang) {
    foot.push(langChip(fx, 118, lang, color, 13));
    foot.push(`<text x="${fx + 19}" y="128" font-family="${T.mono}" font-size="10.5" fill="${T.muted}">${esc(lang)}</text>`);
  }
  const inner = `${icon}${lock}
<text x="24" y="70" font-family="${T.mono}" font-size="14" font-weight="800" fill="${T.text}">${esc(trunc(r.label, 40))}</text>
${desc.map((l, i) => `<text x="24" y="${92 + i * 15}" font-family="${T.sans}" font-size="11.5" fill="${T.sub}">${esc(l)}</text>`).join("\n")}
${foot.join("\n")}`;
  return svg(W, H, card(W, H, `Station ${String(idx + 1).padStart(2, "0")}`, inner), `Station ${idx + 1}: ${r.label}`);
}

function renderLines(m) {
  const W = 840, rows = m.langBars.length, H = 70 + rows * 30 + 14;
  const max = Math.max(...m.langBars.map((l) => l.pct), 1);
  const bx = 190, bw = 520;
  const inner = m.langBars
    .map((l, i) => {
      const y = 66 + i * 30;
      return `${langChip(24, y - 8, l.name, l.color, 16)}
<text x="50" y="${y + 4.5}" font-family="${T.sans}" font-size="12.5" font-weight="700" fill="${T.text}">${esc(l.name)}</text>
<rect x="${bx}" y="${y - 5}" width="${bw}" height="10" rx="5" fill="${T.track}"/>
<rect x="${bx}" y="${y - 5}" width="${Math.max(10, (l.pct / max) * bw).toFixed(1)}" height="10" rx="5" fill="${l.color}">
  <animate attributeName="width" values="0;0;${Math.max(10, (l.pct / max) * bw).toFixed(1)}" keyTimes="0;${(i * 0.08).toFixed(2)};1" dur="1.6s" fill="freeze"/>
</rect>
<text x="${W - 24}" y="${y + 4}" text-anchor="end" font-family="${T.mono}" font-size="11" fill="${T.sub}">${l.pct.toFixed(l.pct < 1 ? 1 : 0)}%</text>`;
    })
    .join("\n");
  const note = `<text x="${W - 24}" y="34" text-anchor="end" font-family="${T.mono}" font-size="9" fill="${T.muted}">by bytes · public + private</text>`;
  return svg(W, H, card(W, H, "Lines", note + inner), "Languages");
}

function renderTimetable(m) {
  const W = 840, H = 200;
  const cs = 12, gap = 4, gx = 24, gy = 52;
  const lv = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };
  const cells = [];
  m.weeks.forEach((w, wi) => {
    w.contributionDays.forEach((d) => {
      const dow = new Date(d.date + "T00:00:00Z").getUTCDay();
      const x = gx + wi * (cs + gap), y = gy + dow * (cs + gap);
      cells.push(`<rect x="${x}" y="${y}" width="${cs}" height="${cs}" rx="2.5" fill="${HEAT[lv[d.contributionLevel] ?? 0]}"><title>${d.date}: ${d.contributionCount} contributions</title></rect>`);
    });
  });
  const sx = gx + 26 * (cs + gap) + 40;
  const stat = (y, k, v, unit = "") =>
    `<text x="${sx}" y="${y}" font-family="${T.mono}" font-size="9" font-weight="700" letter-spacing="1.4" fill="${T.muted}">${k}</text>
<text x="${sx}" y="${y + 24}" font-family="${T.sans}" font-size="21" font-weight="800" fill="${T.text}">${v}${unit ? `<tspan dx="6" font-size="15" fill="${T.sub}">${unit}</tspan>` : ""}</text>`;
  const s = m.stats;
  const legend = HEAT.map((c, i) => `<rect x="${gx + 46 + i * 15}" y="${H - 26}" width="11" height="11" rx="2" fill="${c}"/>`).join("");
  const inner = `${cells.join("\n")}
<text x="${gx}" y="${H - 16.5}" font-family="${T.mono}" font-size="9" fill="${T.muted}">less</text>${legend}<text x="${gx + 46 + 5 * 15 + 4}" y="${H - 16.5}" font-family="${T.mono}" font-size="9" fill="${T.muted}">more</text>
${stat(62, "RUNNING FOR", s.current, s.current === 1 ? "day" : "days")}
${stat(112, "LONGEST SERVICE", s.longest, s.longest === 1 ? "day" : "days")}
${stat(162, `TRIPS IN ${new Date().getUTCFullYear()}`, s.yearTotal.toLocaleString("en-US"), s.yearPrivate ? `(${s.yearPrivate.toLocaleString("en-US")} private)` : "")}`;
  return svg(W, H, card(W, H, "Timetable · 26 weeks", inner), "Contribution timetable");
}

// ───────────────────────────── main ─────────────────────────────
const raw = await fetchAll();
const m = process_(raw);
const avatar = await avatarData(m.user.avatarUrl);
await fs.mkdir(OUT, { recursive: true });

const files = {
  "map.svg": renderMap(m, avatar),
  "interchange.svg": renderInterchange(m, avatar),
  "lines.svg": renderLines(m),
  "timetable.svg": renderTimetable(m),
};
m.stations.forEach((r, i) => (files[`station-${i + 1}.svg`] = renderStation(r, i, m.colors)));
for (const [f, c] of Object.entries(files)) await fs.writeFile(path.join(OUT, f), c);

// Rewrite the station block of README so cards link to their repos.
const readmePath = path.join(ROOT, "README.md");
let readme = await fs.readFile(readmePath, "utf8").catch(() => "");
const block = m.stations
  .map((r, i) => `<a href="${r.link}"><img src="metro/station-${i + 1}.svg" width="49%" alt="${esc(r.label)}"/></a>`)
  .join("\n");
readme = readme.replace(/(<!-- STATIONS:START -->)[\s\S]*?(<!-- STATIONS:END -->)/, `$1\n${block}\n$2`);
await fs.writeFile(readmePath, readme);

console.log(`✔ Commit Metro generated: ${m.stats.repoTotal} repos (${m.stats.repoPrivate} private), ${m.lines.length} lines, ${m.stations.length} stations, ${m.stats.yearTotal} contributions this year.`);
