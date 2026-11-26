#!/usr/bin/env node
// Commit Metro — self-hosted GitHub profile generator.
// "Every line is a language, every stop a project."
//
// Pulls ALL GitHub activity for the configured user:
//   - Personal repositories (public + private)
//   - Organization & Collaborator repositories where the user has commits/contributions
//   - Forks only when the user actually authored commits in them
//
// Orders metro stops chronologically from LEFT (oldest pushedAt) through the
// central @hub to RIGHT (most recently active), dynamically sizes up to 8
// language lines (including an Infra / Docs line for language-less repos),
// renders 6 featured Station cards, language bars, and a 26-week timetable.
//
// Output is 100% deterministic so scheduled auto-sync commits ONLY on real changes.
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
  console.error("✖ Set METRO_TOKEN (Classic PAT with repo + read:user + read:org) to include private & org data.");
  process.exit(1);
}

const LOGIN = config.username;
const PRIVACY = config.privacy || "show"; // show | mask | hide
const INFRA_LINE = config.infraLineName || "Infra / Docs";
const INFRA_COLOR = "#8b949e";

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

const LANG_COLORS = {
  Rust: "#dea584",
  Go: "#00ADD8",
  Python: "#3572A5",
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  "C++": "#f34b7d",
  C: "#555555",
  "C#": "#178600",
  Shell: "#89e051",
  Java: "#b07219",
  Kotlin: "#A97BFF",
  HTML: "#e34c26",
  CSS: "#563d7c",
  Dockerfile: "#384d54",
  HCL: "#844FBA",
  Nix: "#7e7eff",
  Zig: "#ec915c",
  [INFRA_LINE]: INFRA_COLOR,
};

const ABBR = {
  JavaScript: "JS", TypeScript: "TS", Python: "PY", Go: "GO", Shell: "SH", "C++": "C++",
  C: "C", "C#": "C#", Java: "JV", Kotlin: "KT", Rust: "RS", HTML: "HT", CSS: "CSS",
  SCSS: "SC", PHP: "PHP", Ruby: "RB", Dart: "DT", Swift: "SW", Vue: "VU", Svelte: "SV",
  HCL: "HCL", Dockerfile: "DK", Lua: "LUA", "Jupyter Notebook": "NB", PowerShell: "PS",
  Makefile: "MK", Nix: "NIX", Zig: "ZIG", Haskell: "HS", Elixir: "EX", Scala: "SC",
  Batchfile: "BAT", PLSQL: "SQL", TSQL: "SQL", Assembly: "ASM", Blade: "BL", Astro: "AS",
  YAML: "YML", Markdown: "MD", [INFRA_LINE]: "OPS",
};
const abbr = (l) => ABBR[l] || (l || "?").slice(0, 2).toUpperCase();

// ───────────────────────────── helpers ─────────────────────────────
const esc = (s = "") =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const trunc = (s, n) => {
  const str = String(s || "");
  return str.length > n ? str.slice(0, Math.max(1, n - 1)).trimEnd() + "…" : str;
};

function wrap(text, maxChars, maxLines) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const words = clean.split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars) {
      if (cur) lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  const used = lines.join(" ").length;
  if (used < clean.length && lines.length) {
    lines[lines.length - 1] = trunc(lines[lines.length - 1], maxChars - 1).replace(/…+$/, "") + "…";
  }
  return lines.slice(0, maxLines).map((l) => trunc(l, maxChars + 1));
}

function luminance(hex) {
  const h = (hex || "#8b949e").replace("#", "");
  if (h.length !== 6) return 0.3;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ink = (hex) => (luminance(hex) > 0.55 ? "#0d1117" : "#ffffff");
const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtMonthYear(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function matchesRepoList(repo, set) {
  if (!set.size) return false;
  return set.has(repo.name.toLowerCase()) || set.has((repo.nameWithOwner || "").toLowerCase());
}

// Extracts a clean 1-2 sentence summary from a repository's README.md,
// skipping HTML wrappers, badges, navigation links, tables, and code fences.
function extractReadmeSummary(md) {
  if (!md) return null;
  const cleaned = String(md)
    .replace(/<!--[\s\S]*?-->/g, "\n")
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/~~~[\s\S]*?~~~/g, "\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "")
    .replace(/<img[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(div|p|span|a|center|sub|sup|b|strong|i|em|h[1-6]|picture|source)[^>]*>/gi, "");

  const rawBlocks = cleaned.split(/\n\s*\n/);
  const candidates = [];
  for (const block of rawBlocks) {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^#{1,6}\s/.test(l) && !/^[-*_]{3,}$/.test(l) && !/^\|/.test(l) && !/^>\s*\[!/.test(l));
    if (!lines.length) continue;
    // Skip pure navigation / bullet link lines (e.g. "[Arch](#a) • [Docs](#b)")
    const nonNav = lines.filter((l) => {
      const stripped = l
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[•·|/\-*\s]/g, "");
      const linkCount = (l.match(/\]\(#?[^)]+\)/g) || []).length;
      return stripped.length > 0 && !(linkCount >= 2 && stripped.length < 60);
    });
    if (!nonNav.length) continue;
    let text = nonNav
      .join(" ")
      .replace(/^>\s*/g, "")
      .replace(/^[-*+]\s+/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/&bull;|&#8226;/gi, "·")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();
    // Strip leading emojis / decorative symbols for cleaner card typography.
    text = text.replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, "").trim();
    if (text.length >= 35 && /[a-zA-Z]{4,}/.test(text)) {
      candidates.push(text);
    }
  }
  if (!candidates.length) return null;
  // Prefer a rich descriptive paragraph (>= 60 chars) over a short motto line when available.
  const best = candidates.find((c) => c.length >= 60 && !/^\[/.test(c)) || candidates[0];
  // If the first sentence is already substantial (65..118 chars), stop there;
  // otherwise keep up to 2 sentences so short mottos include the actual explanation.
  const s1 = best.match(/^[^.!?]{65,118}[.!?]/);
  if (s1) return s1[0].trim();
  const s2 = best.match(/^[^.!?]+[.!?]\s+[^.!?]{15,110}[.!?]/);
  if (s2 && s2[0].length <= 135) return s2[0].trim();
  return best;
}

function svg(w, h, body, title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
${body}
</svg>
`;
}

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
  const fs = a.length > 2 ? size * 0.4 : size * 0.5;
  return `<g transform="translate(${x},${y})">
  <rect width="${size}" height="${size}" rx="${(size * 0.22).toFixed(1)}" fill="${color}"/>
  <text x="${size / 2}" y="${(size / 2 + fs * 0.36).toFixed(1)}" text-anchor="middle" font-family="${T.mono}" font-size="${fs.toFixed(1)}" font-weight="800" fill="${ink(color)}">${esc(a)}</text>
</g>`;
}

// Crisp vector padlock so private badges never depend on OS emoji fonts.
function lockIcon(x, y, size = 9, color = T.muted) {
  const s = size / 12;
  return `<g transform="translate(${x},${y}) scale(${s.toFixed(3)})" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="2.2" y="5.5" width="7.6" height="5.5" rx="1.3" fill="${color}" fill-opacity="0.18"/>
  <path d="M3.8 5.5V3.9a2.2 2.2 0 0 1 4.4 0v1.6"/>
</g>`;
}

// ───────────────────────────── GraphQL client ─────────────────────────────
async function gql(query, variables = {}, { allowPartial = false } = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "commit-metro",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json, null, 2));
  if (json.errors) {
    if (!allowPartial || !json.data) {
      throw new Error(JSON.stringify(json.errors, null, 2));
    }
    const msgs = [...new Set(json.errors.map((e) => e.message))].slice(0, 3);
    console.warn(`⚠ GraphQL partial errors (${json.errors.length}): ${msgs.join(" | ")}`);
  }
  return json.data;
}

const REPO_FIELDS = `
  name
  nameWithOwner
  owner { login }
  url
  description
  isPrivate
  isFork
  isArchived
  isEmpty
  createdAt
  pushedAt
  stargazerCount
  forkCount
  primaryLanguage { name color }
  languages(first: 20, orderBy: { field: SIZE, direction: DESC }) {
    edges { size node { name color } }
  }
`;

async function fetchAll() {
  const now = new Date();
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString();

  const head = await gql(
    `query($login:String!, $yearStart:DateTime!){
      viewer { id login }
      user(login:$login){
        id login name bio location company websiteUrl avatarUrl(size:200)
        followers { totalCount }
        calendar: contributionsCollection {
          contributionYears
          restrictedContributionsCount
          contributionCalendar {
            totalContributions
            weeks { contributionDays { date contributionCount contributionLevel } }
          }
        }
        year: contributionsCollection(from:$yearStart) {
          totalCommitContributions
          restrictedContributionsCount
          contributionCalendar { totalContributions }
          commitContributionsByRepository(maxRepositories:100) {
            contributions { totalCount }
            repository { isPrivate }
          }
          pullRequestContributionsByRepository(maxRepositories:50) {
            contributions { totalCount }
            repository { isPrivate }
          }
          issueContributionsByRepository(maxRepositories:50) {
            contributions { totalCount }
            repository { isPrivate }
          }
        }
      }
    }`,
    { login: LOGIN, yearStart }
  );

  const isSelf = head.viewer.login.toLowerCase() === LOGIN.toLowerCase();
  const userId = head.user.id;
  if (!isSelf) {
    console.warn(`⚠ Token belongs to ${head.viewer.login}, not ${LOGIN} — only public owned repos are visible until METRO_TOKEN is configured.`);
  }

  // 1) Collect all repos across OWNER, COLLABORATOR, ORGANIZATION_MEMBER (when isSelf),
  //    or public OWNER repos when running under fallback GITHUB_TOKEN (github-actions[bot]).
  const repoMap = new Map();
  const addRepo = (node, source) => {
    if (!node || !node.nameWithOwner) return;
    const key = node.nameWithOwner.toLowerCase();
    const myCommits = node.defaultBranchRef?.target?.myCommits?.totalCount || 0;
    const prev = repoMap.get(key);
    if (!prev) {
      repoMap.set(key, {
        ...node,
        myCommitsCount: myCommits,
        affiliated: source === "affiliated" || source === "org",
      });
    } else {
      prev.myCommitsCount = Math.max(prev.myCommitsCount, myCommits);
      prev.affiliated = prev.affiliated || source === "affiliated" || source === "org";
    }
  };

  const repoFilter = isSelf
    ? `affiliations:${config.includeOrgAndCollab !== false ? "[OWNER, COLLABORATOR, ORGANIZATION_MEMBER]" : "[OWNER]"}`
    : "ownerAffiliations:OWNER";

  let after = null;
  do {
    const q = `query(${isSelf ? "" : "$login:String!, "}$after:String, $userId:ID!){
      ${isSelf ? "owner: viewer" : "owner: user(login:$login)"} {
        repositories(first:100, after:$after, ${repoFilter}, orderBy:{field:PUSHED_AT, direction:DESC}) {
          pageInfo { hasNextPage endCursor }
          nodes {
            ${REPO_FIELDS}
            defaultBranchRef {
              target {
                ... on Commit {
                  myCommits: history(first:1, author:{id:$userId}) { totalCount }
                }
              }
            }
          }
        }
      }
    }`;
    const d = await gql(q, isSelf ? { after, userId } : { login: LOGIN, after, userId }, { allowPartial: true });
    const r = d?.owner?.repositories;
    if (!r) break;
    for (const node of r.nodes || []) addRepo(node, "affiliated");
    after = r.pageInfo?.hasNextPage ? r.pageInfo.endCursor : null;
  } while (after);

  // 2) Supplementary pass: enumerate viewer's organizations explicitly so no org repo is missed.
  if (isSelf && config.includeOrgAndCollab !== false) {
    try {
      const orgData = await gql(
        `query($userId:ID!){
          viewer {
            organizations(first:50) {
              nodes {
                login
                repositories(first:100, orderBy:{field:PUSHED_AT, direction:DESC}) {
                  nodes {
                    ${REPO_FIELDS}
                    defaultBranchRef {
                      target {
                        ... on Commit {
                          myCommits: history(first:1, author:{id:$userId}) { totalCount }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }`,
        { userId },
        { allowPartial: true }
      );
      for (const org of orgData?.viewer?.organizations?.nodes || []) {
        for (const node of org?.repositories?.nodes || []) addRepo(node, "org");
      }
    } catch (err) {
      console.warn(`⚠ Organization lookup skipped (${err.message.slice(0, 120)})`);
    }
  }

  // 3) Collect contributed repositories across ALL contribution years so commits on
  //    non-default branches or secondary emails in org/collab repos are never missed.
  const contributedRepos = new Map(); // key -> total contributions
  const years = (head.user.calendar.contributionYears || [now.getUTCFullYear()]).slice(0, 8);
  if (years.length) {
    const yearBlocks = years
      .map((y) => {
        const from = `${y}-01-01T00:00:00Z`;
        const to = `${y}-12-31T23:59:59Z`;
        return `y${y}: contributionsCollection(from:"${from}", to:"${to}") {
          commitContributionsByRepository(maxRepositories:100) {
            contributions { totalCount }
            repository { ${REPO_FIELDS} }
          }
          pullRequestContributionsByRepository(maxRepositories:50) {
            contributions { totalCount }
            repository { ${REPO_FIELDS} }
          }
        }`;
      })
      .join("\n");

    try {
      const hist = await gql(
        `query($login:String!){ user(login:$login){ ${yearBlocks} } }`,
        { login: LOGIN },
        { allowPartial: true }
      );
      for (const y of years) {
        const col = hist?.user?.[`y${y}`];
        if (!col) continue;
        for (const list of [col.commitContributionsByRepository || [], col.pullRequestContributionsByRepository || []]) {
          for (const entry of list) {
            const repo = entry?.repository;
            if (!repo?.nameWithOwner) continue;
            const key = repo.nameWithOwner.toLowerCase();
            contributedRepos.set(key, (contributedRepos.get(key) || 0) + (entry.contributions?.totalCount || 0));
            // Private contributed repos always belong to user's teams/orgs even if org affiliation wasn't listed.
            if (repo.isPrivate && !repoMap.has(key)) {
              addRepo(repo, "org");
            }
          }
        }
      }
    } catch (err) {
      console.warn(`⚠ Multi-year contribution scan partial (${err.message.slice(0, 120)})`);
    }
  }

  // 4) Explicitly fetch any pinned `owner/repo` stations not yet in repoMap,
  //    plus README.md blobs for repos configured in `descriptionFromReadme`.
  const readmeTargets = new Set(
    (config.descriptionFromReadme || []).map((s) => s.toLowerCase())
  );
  const pinnedFullNames = (config.stations || []).filter((s) => s.includes("/"));
  const directLookups = new Set([
    ...pinnedFullNames.map((s) => s.toLowerCase()),
    ...[...readmeTargets].filter((s) => s.includes("/")),
  ]);

  const readmeTexts = new Map();
  for (const full of directLookups) {
    const [owner, name] = full.split("/");
    if (!owner || !name) continue;
    const existing = repoMap.get(full);
    const needRepo = !existing;
    const needReadme = readmeTargets.has(full) || (existing && !existing.description);
    if (!needRepo && !needReadme) continue;
    try {
      const q = `query($owner:String!, $name:String!${needRepo ? ", $userId:ID!" : ""}){
        repository(owner:$owner, name:$name){
          ${needRepo ? `${REPO_FIELDS}
          defaultBranchRef {
            target {
              ... on Commit {
                myCommits: history(first:1, author:{id:$userId}) { totalCount }
              }
            }
          }` : "nameWithOwner"}
          ${needReadme || needRepo ? `
          r1: object(expression:"HEAD:README.md") { ... on Blob { text } }
          r2: object(expression:"HEAD:readme.md") { ... on Blob { text } }
          r3: object(expression:"HEAD:Readme.md") { ... on Blob { text } }` : ""}
        }
      }`;
      const vars = needRepo ? { owner, name, userId } : { owner, name };
      const d = await gql(q, vars, { allowPartial: true });
      const repo = d?.repository;
      if (repo) {
        if (needRepo) addRepo(repo, "affiliated");
        const md = repo.r1?.text || repo.r2?.text || repo.r3?.text || null;
        if (md) readmeTexts.set(repo.nameWithOwner.toLowerCase(), md);
      }
    } catch (err) {
      console.warn(`⚠ Direct lookup skipped for ${owner}/${name} (${err.message.slice(0, 90)})`);
    }
  }

  return {
    isSelf,
    user: head.user,
    repos: [...repoMap.values()],
    contributedRepos,
    readmeTexts,
  };
}

// ───────────────────────────── processing ─────────────────────────────
function processData(data) {
  const { user, repos: rawRepos, contributedRepos, readmeTexts = new Map() } = data;
  const excludeSet = new Set((config.excludeRepos || []).map((s) => s.toLowerCase()));
  const maskSet = new Set((config.maskRepos || []).map((s) => s.toLowerCase()));
  const exLang = new Set((config.excludeLanguages || []).map((s) => s.toLowerCase()));
  const overrides = new Map(
    Object.entries(config.languageOverrides || {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  const descOverrides = new Map(
    Object.entries(config.descriptionOverrides || {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  const readmeDescSet = new Set(
    (config.descriptionFromReadme || []).map((s) => s.toLowerCase())
  );
  const pinnedSet = new Set(
    (config.stations || []).map((s) => s.toLowerCase())
  );
  const pinLangs = (config.pinLanguages || []).map((s) => s.toLowerCase());

  const loginLower = LOGIN.toLowerCase();
  let skippedForks = 0;
  let skippedUntouchedOrg = 0;

  // Apply inclusion rules:
  //   1. All personal non-fork repos (public + private)
  //   2. Any Org / Collaborator repo where user has commits or contributions
  //   3. Forks ONLY when user authored commits or contributions in them
  //   4. Explicitly pinned station repos are always included when accessible
  const included = [];
  for (const r of rawRepos) {
    if (matchesRepoList(r, excludeSet)) continue;
    const key = r.nameWithOwner.toLowerCase();
    const isOwned = (r.owner?.login || "").toLowerCase() === loginLower;
    const isPinned = matchesRepoList(r, pinnedSet);
    const contribCount = (r.myCommitsCount || 0) + (contributedRepos.get(key) || 0);
    const hasMyWork = contribCount > 0;

    if (r.isFork) {
      if (isPinned || (config.includeContributedForks !== false && hasMyWork)) {
        included.push({ ...r, isOwned, contribCount });
      } else {
        skippedForks++;
      }
      continue;
    }

    if (isOwned || hasMyWork || isPinned) {
      included.push({ ...r, isOwned, contribCount });
    } else {
      skippedUntouchedOrg++;
    }
  }

  // Normalize timestamps (pushedAt primary, fallback createdAt) & sort deterministically.
  const enriched = included.map((r) => {
    const activeAt = r.pushedAt || r.createdAt;
    const ts = activeAt ? Date.parse(activeAt) : 0;
    const overrideLang = overrides.get(r.name.toLowerCase()) || overrides.get(r.nameWithOwner.toLowerCase());
    const detectedLang = r.primaryLanguage?.name || null;
    const lineLang = overrideLang || detectedLang || (config.includeInfraLine !== false ? INFRA_LINE : null);
    const lineColor =
      (overrideLang && LANG_COLORS[overrideLang]) ||
      r.primaryLanguage?.color ||
      LANG_COLORS[lineLang] ||
      INFRA_COLOR;
    return { ...r, activeAt, ts, lineLang, lineColor };
  });

  // Sort newest -> oldest for deterministic masking index & station picking.
  enriched.sort((a, b) => b.ts - a.ts || a.nameWithOwner.localeCompare(b.nameWithOwner));

  // Build display-safe view of each repo honouring privacy, maskRepos,
  // descriptionOverrides, and live README.md description extraction.
  let maskIndex = 0;
  const toView = (r) => {
    const key = r.nameWithOwner.toLowerCase();
    const forceMask = matchesRepoList(r, maskSet);
    const isMasked = r.isPrivate && (PRIVACY === "mask" || forceMask);
    if (isMasked) {
      maskIndex += 1;
      return {
        ...r,
        label: `private-${String(maskIndex).padStart(2, "0")}`,
        desc: "Private project — details classified.",
        link: null,
        masked: true,
        showOrg: false,
      };
    }
    const customDesc = descOverrides.get(key) || descOverrides.get(r.name.toLowerCase());
    const forceReadme = matchesRepoList(r, readmeDescSet);
    const readmeSummary = readmeTexts.has(key) ? extractReadmeSummary(readmeTexts.get(key)) : null;
    return {
      ...r,
      label: r.name,
      desc:
        customDesc ||
        (forceReadme ? readmeSummary : null) ||
        r.description ||
        readmeSummary ||
        (r.isPrivate ? "Private project in progress." : "A project in progress."),
      link: r.isPrivate ? null : r.url,
      masked: false,
      showOrg: !r.isOwned,
    };
  };

  const visibleRaw = PRIVACY === "hide" ? enriched.filter((r) => !r.isPrivate) : enriched;
  const visible = visibleRaw.map(toView);
  const byKey = new Map(visible.map((r) => [r.nameWithOwner.toLowerCase(), r]));
  const byName = new Map();
  for (const r of visible) {
    if (!byName.has(r.name.toLowerCase())) byName.set(r.name.toLowerCase(), r);
  }

  // Languages by bytes across ALL included repos (public + private + contributed org/collab).
  const bytes = new Map();
  const colors = new Map(Object.entries(LANG_COLORS));
  for (const r of enriched) {
    if (r.primaryLanguage?.name && r.primaryLanguage?.color) {
      colors.set(r.primaryLanguage.name, r.primaryLanguage.color);
    }
    for (const e of r.languages?.edges || []) {
      const name = e.node.name;
      if (e.node.color) colors.set(name, e.node.color);
      if (exLang.has(name.toLowerCase())) continue;
      bytes.set(name, (bytes.get(name) || 0) + e.size);
    }
  }
  const totalBytes = [...bytes.values()].reduce((a, b) => a + b, 0) || 1;
  const langBars = [...bytes.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, config.maxLanguagesInBars || 8)
    .map(([name, b]) => ({
      name,
      color: colors.get(name) || "#8b949e",
      pct: (b / totalBytes) * 100,
    }));

  // Group visible repos into Metro Lines.
  const byLang = new Map();
  for (const r of visible) {
    const l = r.lineLang;
    if (!l || exLang.has(l.toLowerCase())) continue;
    if (!colors.has(l)) colors.set(l, r.lineColor || "#8b949e");
    if (!byLang.has(l)) byLang.set(l, []);
    byLang.get(l).push(r);
  }

  // Rank lines: pinned languages first, then composite score of repo count + byte weight,
  // keeping Infra/Docs cleanly positioned so flagship code languages like Rust/Go always shine.
  const scoreLine = ([name, rs]) => {
    const pinIdx = pinLangs.indexOf(name.toLowerCase());
    if (pinIdx !== -1) return 1e9 - pinIdx;
    const b = bytes.get(name) || 0;
    const isInfra = name === INFRA_LINE;
    const base = rs.length * 2.0 + Math.log10(b + 10) * 0.85;
    return isInfra ? Math.min(base, rs.length * 1.4) : base;
  };

  const maxLines = Math.max(1, Math.min(8, config.maxLines || 8));
  const lines = [...byLang.entries()]
    .sort((a, b) => scoreLine(b) - scoreLine(a) || a[0].localeCompare(b[0]))
    .slice(0, maxLines)
    .map(([name, rs]) => ({
      name,
      color: colors.get(name) || "#8b949e",
      // Strict chronological order: OLDEST -> NEWEST (left -> right).
      repos: [...rs].sort((a, b) => a.ts - b.ts || a.nameWithOwner.localeCompare(b.nameWithOwner)),
    }));

  // Compute global timeline bounds & median split timestamp across all plotted repos.
  const allPlottedTs = lines
    .flatMap((l) => l.repos.map((r) => r.ts))
    .filter((t) => t > 0)
    .sort((a, b) => a - b);
  const minTs = allPlottedTs[0] || 0;
  const maxTs = allPlottedTs[allPlottedTs.length - 1] || 0;
  const midTs = allPlottedTs.length
    ? allPlottedTs[Math.floor(allPlottedTs.length / 2)]
    : 0;

  // Featured Stations (6 cards by default): manual pins first, then most recently active.
  const fallbacks = new Map(
    Object.entries(config.stationFallbacks || {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  const stationCount = config.stationCount || 6;
  const stations = [];
  const usedKeys = new Set();
  for (const s of config.stations || []) {
    const key = s.toLowerCase();
    const found = byKey.get(key) || byName.get(key);
    if (found && !usedKeys.has(found.nameWithOwner.toLowerCase())) {
      stations.push(found);
      usedKeys.add(found.nameWithOwner.toLowerCase());
      continue;
    }
    const fb = fallbacks.get(key);
    if (fb && !usedKeys.has(key)) {
      const fbOwner = fb.owner || (s.includes("/") ? s.split("/")[0] : LOGIN);
      const fbName = fb.name || (s.includes("/") ? s.split("/")[1] : s);
      const fbLang = fb.language || INFRA_LINE;
      stations.push({
        name: fbName,
        nameWithOwner: `${fbOwner}/${fbName}`,
        owner: { login: fbOwner },
        label: fbName,
        desc: fb.description || "Private project in progress.",
        link: fb.isPrivate ? null : fb.url || null,
        isPrivate: fb.isPrivate !== false,
        masked: false,
        showOrg: fbOwner.toLowerCase() !== loginLower,
        lineLang: fbLang,
        lineColor: LANG_COLORS[fbLang] || INFRA_COLOR,
        stargazerCount: fb.stars || 0,
        forkCount: fb.forks || 0,
        activeAt: fb.activeAt || null,
      });
      usedKeys.add(key);
    }
  }
  for (const r of visible) {
    if (stations.length >= stationCount) break;
    const k = r.nameWithOwner.toLowerCase();
    if (!usedKeys.has(k) && !r.isArchived) {
      stations.push(r);
      usedKeys.add(k);
    }
  }

  // Timetable: last 26 weeks + streaks.
  const days = user.calendar.contributionCalendar.weeks.flatMap((w) => w.contributionDays);
  const lastDayDate = days[days.length - 1]?.date || "";
  let longest = 0;
  let run = 0;
  for (const d of days) {
    run = d.contributionCount > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    if (d.contributionCount > 0) current++;
    else if (d.date === lastDayDate && current === 0) continue;
    else break;
  }
  const weeks = user.calendar.contributionCalendar.weeks.slice(-26);

  const privCount = enriched.filter((r) => r.isPrivate).length;
  const orgCollabCount = enriched.filter((r) => !r.isOwned).length;
  const yearNum = Number((lastDayDate || "").slice(0, 4)) || new Date().getUTCFullYear();

  // When authenticated as self, GitHub sets restrictedContributionsCount = 0 because
  // your own private repos aren't restricted to you; sum private repo contributions instead.
  let yearPrivate = user.year.restrictedContributionsCount || 0;
  if (yearPrivate === 0) {
    const lists = [
      user.year.commitContributionsByRepository || [],
      user.year.pullRequestContributionsByRepository || [],
      user.year.issueContributionsByRepository || [],
    ];
    for (const list of lists) {
      for (const entry of list) {
        if (entry?.repository?.isPrivate) {
          yearPrivate += entry.contributions?.totalCount || 0;
        }
      }
    }
  }

  const allLangSummary = [...bytes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, b]) => `${name}:${((b / totalBytes) * 100).toFixed(1)}%`);
  const topReposByBytes = enriched
    .map((r) => ({
      name: r.nameWithOwner,
      kb: Math.round((r.languages?.edges || []).reduce((a, e) => a + e.size, 0) / 1024),
    }))
    .sort((a, b) => b.kb - a.kb)
    .slice(0, 8);

  return {
    user,
    lines,
    langBars,
    stations,
    weeks,
    colors,
    timeline: { minTs, midTs, maxTs },
    diagnostics: { allLangSummary, topReposByBytes },
    stats: {
      current,
      longest,
      yearNum,
      yearTotal: user.year.contributionCalendar.totalContributions,
      yearPrivate,
      repoTotal: enriched.length,
      repoPrivate: privCount,
      orgCollabCount,
      skippedForks,
      skippedUntouchedOrg,
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
  const W = 900;
  const cx = 486; // slight right offset balances left terminus pills
  const L = m.lines;
  const n = L.length;

  const topCount = Math.ceil(n / 2);
  const botCount = n - topCount;
  const step = 48; // generous vertical spacing -> zero label collision between adjacent lines
  const topGap = 54;
  const botGap = 70; // leaves clean air under @lapnes hub label

  const up = Array.from({ length: topCount }, (_, i) => -(topGap + step * (topCount - 1 - i)));
  const down = Array.from({ length: botCount }, (_, i) => botGap + step * i);
  const levels = [...up, ...down];

  const topPad = 114;
  const botPad = 76;
  const maxUp = topCount ? topGap + step * (topCount - 1) : 60;
  const maxDown = botCount ? botGap + step * (botCount - 1) : 60;
  const cy = topPad + maxUp;
  const H = cy + maxDown + botPad;

  // Cross neighbouring tracks smoothly through the central hub.
  const rightOrder = L.map((_, i) => ((i ^ 1) < n ? i ^ 1 : i));

  const tracks = [];
  const stops = [];
  const labels = [];
  const pills = [];
  const trains = [];
  const defs = [];
  const pillX = 28;
  const rightEnd = W - 28;
  const { minTs, midTs, maxTs } = m.timeline;

  const PILL_LABEL = {
    "Jupyter Notebook": "JUPYTER",
    "Objective-C": "OBJ-C",
    "PowerShell": "PWSH",
  };

  L.forEach((line, i) => {
    const pillText = (PILL_LABEL[line.name] || line.name).toUpperCase();
    const pillW = Math.max(82, Math.min(126, Math.ceil(pillText.length * 6.4 + 34)));
    const leftEnd = pillX + pillW;
    const dyL = levels[i];
    const dyR = levels[rightOrder[i]];
    const bendL = cx - (46 + Math.abs(dyL) * 0.52);
    const bendR = cx + (46 + Math.abs(dyR) * 0.52);
    const yL = cy + dyL;
    const yR = cy + dyR;

    const pathL = `M${leftEnd},${yL} L${bendL.toFixed(1)},${yL} L${cx},${cy}`;
    const pathR = `M${cx},${cy} L${bendR.toFixed(1)},${yR} L${rightEnd},${yR}`;
    tracks.push(
      `<path d="${pathL}" fill="none" stroke="${line.color}" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>`
    );
    tracks.push(
      `<path d="${pathR}" fill="none" stroke="${line.color}" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>`
    );

    // Terminus pill (left) + buffer stop (right).
    const a = abbr(line.name);
    const fg = ink(line.color);
    pills.push(`<g transform="translate(${pillX},${yL - 10})">
  <rect width="${pillW}" height="20" rx="10" fill="${line.color}"/>
  <rect x="4.5" y="3" width="14" height="14" rx="3" fill="${fg}"/>
  <text x="11.5" y="${a.length > 2 ? 12.4 : 13.1}" text-anchor="middle" font-family="${T.mono}" font-size="${a.length > 2 ? 5.6 : 6.8}" font-weight="800" fill="${line.color}">${esc(a)}</text>
  <text x="${((pillW + 20) / 2 + 1).toFixed(1)}" y="13.6" text-anchor="middle" font-family="${T.mono}" font-size="9" font-weight="800" letter-spacing="0.5" fill="${fg}">${esc(trunc(pillText, 13))}</text>
</g>`);
    pills.push(`<rect x="${rightEnd - 3}" y="${yR - 9}" width="6" height="18" rx="3" fill="${line.color}"/>`);

    // Split line's chronologically sorted repos around the global median timestamp:
    //   older (< midTs) -> LEFT arm (oldest at far left -> newer toward hub)
    //   newer (>= midTs) -> RIGHT arm (older near hub -> newest at far right)
    let leftAll = line.repos.filter((r) => r.ts < midTs);
    let rightAll = line.repos.filter((r) => r.ts >= midTs);
    // Edge case: if all timestamps are identical, put newest on right.
    if (!leftAll.length && !rightAll.length && line.repos.length) rightAll = line.repos;

    const segL = [leftEnd + 28, bendL - 22];
    const segR = [bendR + 26, rightEnd - 28];
    const spanL = Math.max(0, segL[1] - segL[0]);
    const spanR = Math.max(0, segR[1] - segR[0]);
    const capL = Math.max(1, Math.min(4, Math.floor(spanL / 72) + 1));
    const capR = Math.max(1, Math.min(4, Math.floor(spanR / 78) + 1));

    let overflow = 0;
    let leftShown = leftAll;
    let rightShown = rightAll;

    if (leftShown.length > capL) {
      overflow += leftShown.length - capL;
      // Keep oldest anchor + most recent stops on the left arm so span stays true.
      leftShown = [leftShown[0], ...leftShown.slice(leftShown.length - (capL - 1))];
    }
    if (rightShown.length > capR) {
      overflow += rightShown.length - capR;
      // Always prioritize the most recently updated projects on the right arm.
      rightShown = rightShown.slice(rightShown.length - capR);
    }

    // Show compact +N overflow badge next to the left terminus when truncated.
    if (overflow > 0) {
      const bx = leftEnd + 5;
      pills.push(`<g transform="translate(${bx},${yL + 9})">
  <rect width="26" height="13" rx="6.5" fill="${T.card}" stroke="${line.color}" stroke-width="1"/>
  <text x="13" y="9.5" text-anchor="middle" font-family="${T.mono}" font-size="8" font-weight="700" fill="${T.sub}">+${overflow}</text>
</g>`);
    }

    const placeArm = (arr, [aX, bX], y, side) => {
      if (!arr.length) return;
      const span = Math.max(0, bX - aX);
      let xs;
      if (arr.length === 1) {
        // Position single stop naturally along its half of the timeline.
        const r0 = arr[0];
        if (side === "L") {
          const ratio = midTs > minTs ? Math.min(1, Math.max(0, (r0.ts - minTs) / (midTs - minTs))) : 0.5;
          xs = [aX + span * (0.2 + ratio * 0.65)];
        } else {
          const ratio = maxTs > midTs ? Math.min(1, Math.max(0, (r0.ts - midTs) / (maxTs - midTs))) : 0.5;
          xs = [aX + span * (0.2 + ratio * 0.65)];
        }
      } else {
        // Strictly ordered left-to-right (oldest -> newest) with even readable spacing.
        xs = arr.map((_, k) => aX + (span * k) / (arr.length - 1));
      }

      const spacing = arr.length > 1 ? span / (arr.length - 1) : 220;
      const staggered = arr.length >= 2 && spacing < 195;
      // Same-side neighbor distance is 2*spacing when staggered, minus room for edge clamping.
      const availW = staggered
        ? Math.min(arr.length >= 3 ? spacing * 1.38 : spacing * 1.7, 152)
        : Math.min(spacing - 18, 170);
      arr.forEach((r, k) => {
        const x = xs[k];
        const above = staggered ? k % 2 === 0 : true;
        const ly = above ? y - 12 : y + 20;
        const maxChars = Math.max(8, Math.min(20, Math.floor((availW - (r.isPrivate ? 12 : 0)) / 6.8)));
        const text = trunc(r.label, maxChars);
        const lockPad = r.isPrivate ? 12 : 0;
        const textW = text.length * 6.8 + lockPad;
        const half = textW / 2;
        const minX = side === "L" ? leftEnd + half + 6 : bendR + half - 18;
        const maxX = side === "L" ? bendL - half + 20 : W - half - 18;
        const tx = Math.min(Math.max(x, Math.min(minX, maxX)), Math.max(minX, maxX));

        const tooltip = `${r.nameWithOwner}${r.isPrivate ? " (Private)" : ""} · ${fmtMonthYear(r.activeAt)}`;
        const circle = r.isPrivate
          ? `<circle cx="${x.toFixed(1)}" cy="${y}" r="6.5" fill="${T.bg}" stroke="#ffffff" stroke-width="2.6" stroke-dasharray="3.2 1.6"><title>${esc(tooltip)}</title></circle><circle cx="${x.toFixed(1)}" cy="${y}" r="2.2" fill="${T.accent}"/>`
          : `<circle cx="${x.toFixed(1)}" cy="${y}" r="6.5" fill="${T.bg}" stroke="#ffffff" stroke-width="2.8"><title>${esc(tooltip)}</title></circle>`;

        stops.push(r.link ? `<a xlink:href="${esc(r.link)}" target="_blank">${circle}</a>` : `<g>${circle}</g>`);

        if (r.isPrivate) {
          const lx = tx - textW / 2;
          labels.push(
            `${lockIcon(lx.toFixed(1), (ly - 8.5).toFixed(1), 8.5, T.accent)}` +
            `<text x="${(lx + 11).toFixed(1)}" y="${ly}" text-anchor="start" font-family="${T.sans}" font-size="10.2" font-weight="700" fill="${T.text}" stroke="${T.bg}" stroke-width="3.2" paint-order="stroke">${esc(text)}</text>`
          );
        } else {
          labels.push(
            `<text x="${tx.toFixed(1)}" y="${ly}" text-anchor="middle" font-family="${T.sans}" font-size="10.2" font-weight="700" fill="${T.text}" stroke="${T.bg}" stroke-width="3.2" paint-order="stroke">${esc(text)}</text>`
          );
        }
      });
    };

    placeArm(leftShown, segL, yL, "L");
    placeArm(rightShown, segR, yR, "R");

    // Deterministic animated trains gliding along both arms.
    const durL = (7.2 + ((i * 37) % 5) * 0.9).toFixed(1);
    const durR = (8.0 + ((i * 53) % 5) * 0.9).toFixed(1);
    defs.push(
      `<path id="tl${i}" d="M${leftEnd + 8},${yL} L${bendL.toFixed(1)},${yL} L${cx},${cy}"/>`,
      `<path id="tr${i}" d="M${cx},${cy} L${bendR.toFixed(1)},${yR} L${rightEnd - 10},${yR}"/>`
    );
    for (const [id, dur, begin] of [
      [`tl${i}`, durL, `-${(i * 1.3).toFixed(1)}s`],
      [`tr${i}`, durR, `-${(i * 2.1 + 0.7).toFixed(1)}s`],
    ]) {
      trains.push(`<g opacity="0"><set attributeName="opacity" to="1" begin="0s"/><rect x="-10" y="-4.5" width="20" height="9" rx="4" fill="#ffffff" stroke="${line.color}" stroke-width="2"/>
  <animateMotion dur="${dur}s" begin="${begin}" repeatCount="indefinite" rotate="auto" keyPoints="0;1;0" keyTimes="0;0.5;1" calcMode="linear"><mpath xlink:href="#${id}"/></animateMotion></g>`);
    }
  });

  const hub = `<g>
  <circle cx="${cx}" cy="${cy}" r="31" fill="${T.bg}" stroke="#ffffff" stroke-width="3.5"/>
  ${
    avatar
      ? `<image xlink:href="${avatar}" x="${cx - 26}" y="${cy - 26}" width="52" height="52" clip-path="url(#hubclip)" preserveAspectRatio="xMidYMid slice"/>`
      : `<text x="${cx}" y="${cy + 6}" text-anchor="middle" font-family="${T.sans}" font-size="18" font-weight="800" fill="#fff">${esc(m.user.login[0].toUpperCase())}</text>`
  }
  <text x="${cx}" y="${cy + 48}" text-anchor="middle" font-family="${T.sans}" font-size="11.5" font-weight="800" fill="#ffffff" stroke="${T.bg}" stroke-width="4" paint-order="stroke">@${esc(m.user.login.toLowerCase())}</text>
</g>`;

  // Bottom timeline bar showing oldest -> newest orientation.
  const axisY = H - 36;
  const oldLabel = minTs ? `← OLDER · ${fmtMonthYear(new Date(minTs).toISOString())}` : "← OLDER";
  const newLabel = maxTs ? `${fmtMonthYear(new Date(maxTs).toISOString())} · RECENT →` : "RECENT →";
  const timelineBar = `<g>
  <line x1="28" y1="${axisY}" x2="${W - 28}" y2="${axisY}" stroke="${T.border}" stroke-width="1" stroke-dasharray="3 4"/>
  <text x="28" y="${axisY + 16}" font-family="${T.mono}" font-size="9" font-weight="700" fill="${T.muted}">${esc(oldLabel)}</text>
  <text x="${cx}" y="${axisY + 16}" text-anchor="middle" font-family="${T.mono}" font-size="9" fill="${T.muted}">TIMELINE · ORDERED BY LAST ACTIVITY</text>
  <text x="${W - 28}" y="${axisY + 16}" text-anchor="end" font-family="${T.mono}" font-size="9" font-weight="700" fill="${T.green}">${esc(newLabel)}</text>
</g>`;

  const summaryBits = [
    `${m.stats.repoTotal} projects`,
    `${m.stats.repoPrivate} private`,
    m.stats.orgCollabCount ? `${m.stats.orgCollabCount} org/collab` : null,
    `${L.length} lines`,
  ].filter(Boolean);

  const body = `<defs>
  <clipPath id="hubclip"><circle cx="${cx}" cy="${cy}" r="26"/></clipPath>
  ${defs.join("\n  ")}
</defs>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="16" fill="${T.bg}" stroke="${T.border}"/>
<text x="28" y="38" font-family="${T.mono}" font-size="10.5" font-weight="700" letter-spacing="2" fill="${T.green}">COMMIT METRO</text>
<text x="${W - 28}" y="38" text-anchor="end" font-family="${T.mono}" font-size="9.5" fill="${T.muted}">${esc(summaryBits.join(" · "))}</text>
<text x="28" y="66" font-family="${T.sans}" font-size="22" font-weight="800" fill="${T.text}">Every line is a language, every stop a project</text>
${tracks.join("\n")}
${trains.join("\n")}
${pills.join("\n")}
${stops.join("\n")}
${labels.join("\n")}
${hub}
${timelineBar}`;

  return svg(W, H, body, "Commit Metro map");
}

function renderInterchange(m, avatar) {
  const W = 900;
  const role = config.profile?.role || "";
  const H = role ? 196 : 178;
  const u = m.user;
  const bio = wrap(u.bio || "", 62, 2);
  const repoLabel = m.stats.repoPrivate
    ? `${m.stats.repoTotal} projects (${m.stats.repoPrivate} private)`
    : `${m.stats.repoTotal} projects`;
  const meta = [u.location, u.company, `${u.followers.totalCount} followers`, repoLabel]
    .filter(Boolean)
    .join("  ·  ");

  const bioStartY = role ? 124 : 110;
  const metaY = bio.length ? bioStartY + bio.length * 20 + 6 : bioStartY + 6;
  const roleLine = role
    ? `<text x="24" y="100" font-family="${T.mono}" font-size="11" font-weight="700" fill="${T.green}">${esc(trunc(role, 78))}</text>`
    : "";

  const inner = `
<text x="24" y="76" font-family="${T.sans}" font-size="27" font-weight="800" fill="${T.text}">${esc(trunc(u.name || u.login, 38))}</text>
${roleLine}
${bio.map((l, i) => `<text x="24" y="${bioStartY + i * 20}" font-family="${T.sans}" font-size="14" fill="${T.sub}">${esc(l)}</text>`).join("\n")}
<text x="24" y="${metaY}" font-family="${T.mono}" font-size="10.5" fill="${T.muted}">${esc(trunc(meta, 98))}</text>
<defs><clipPath id="av"><circle cx="${W - 92}" cy="${H / 2 + 4}" r="50"/></clipPath></defs>
<circle cx="${W - 92}" cy="${H / 2 + 4}" r="54" fill="${T.accent}"/>
${avatar ? `<image xlink:href="${avatar}" x="${W - 142}" y="${H / 2 - 46}" width="100" height="100" clip-path="url(#av)" preserveAspectRatio="xMidYMid slice"/>` : ""}`;

  return svg(W, H, card(W, H, "Interchange", inner), `${u.name || u.login} — Interchange`);
}

function renderFleet(fleet = []) {
  const W = 900;
  const padX = 24;
  const chipStartX = 176;
  const maxX = W - 24;
  const chipH = 22;
  const gapX = 7;
  const gapY = 7;

  let y = 58;
  const blocks = [];

  for (const group of fleet) {
    const color = group.color || T.accent;
    // Group label + colored metro track indicator
    blocks.push(
      `<circle cx="${padX + 5}" cy="${y + 11}" r="4.5" fill="${color}"/>` +
      `<text x="${padX + 17}" y="${y + 14.5}" font-family="${T.mono}" font-size="9.5" font-weight="800" letter-spacing="1" fill="${T.sub}">${esc(group.label)}</text>`
    );

    let cx = chipStartX;
    let cy = y;
    for (const item of group.items || []) {
      const text = String(item);
      const pw = Math.ceil(text.length * 6.3 + 18);
      if (cx + pw > maxX && cx > chipStartX) {
        cx = chipStartX;
        cy += chipH + gapY;
      }
      blocks.push(`<g transform="translate(${cx},${cy})">
  <rect width="${pw}" height="${chipH}" rx="6" fill="${T.bg}" stroke="${T.border}"/>
  <rect width="3" height="${chipH - 8}" x="1.5" y="4" rx="1.5" fill="${color}"/>
  <text x="${(pw / 2 + 1.5).toFixed(1)}" y="14.5" text-anchor="middle" font-family="${T.mono}" font-size="10" font-weight="600" fill="${T.text}">${esc(text)}</text>
</g>`);
      cx += pw + gapX;
    }
    y = cy + chipH + 14;
  }

  const H = y + 8;
  const note = `<text x="${W - 24}" y="34" text-anchor="end" font-family="${T.mono}" font-size="9" fill="${T.muted}">systems · cloud · networking · secops</text>`;
  return svg(W, H, card(W, H, "Fleet · Tech Stack", note + "\n" + blocks.join("\n")), "Tech Stack Fleet");
}

function renderDispatch(dispatch) {
  const W = 900;
  const H = 204;
  const midX = 456;

  const leftItems = [
    { k: "BUILDING", v: dispatch.building, color: T.accent },
    { k: "EXPLORING", v: dispatch.exploring, color: "#00ADD8" },
    { k: "OPEN TO", v: dispatch.openTo, color: T.green, pulse: true },
  ].filter((x) => x.v);

  const left = leftItems
    .map((item, idx) => {
      const y = 62 + idx * 46;
      const dot = item.pulse
        ? `<circle cx="29" cy="${y - 3}" r="3.5" fill="${item.color}"><animate attributeName="opacity" values="1;0.35;1" dur="2.2s" repeatCount="indefinite"/></circle>`
        : `<circle cx="29" cy="${y - 3}" r="3.5" fill="${item.color}"/>`;
      return `${dot}
<text x="40" y="${y}" font-family="${T.mono}" font-size="9" font-weight="700" letter-spacing="1.4" fill="${T.muted}">${esc(item.k)}</text>
<text x="24" y="${y + 18}" font-family="${T.sans}" font-size="12.2" font-weight="600" fill="${T.text}">${esc(trunc(item.v, 64))}</text>`;
    })
    .join("\n");

  const comm = (dispatch.community || []).slice(0, 3);
  const right = comm
    .map((c, idx) => {
      const y = 62 + idx * 46;
      return `<text x="${midX + 24}" y="${y}" font-family="${T.mono}" font-size="10" font-weight="800" fill="${T.text}">${esc(trunc(c.org, 44))}</text>
<text x="${midX + 24}" y="${y + 18}" font-family="${T.sans}" font-size="11.5" fill="${T.sub}">${esc(trunc(c.role, 64))}</text>`;
    })
    .join("\n");

  const note = `<text x="${W - 24}" y="34" text-anchor="end" font-family="${T.mono}" font-size="9" fill="${T.muted}">active status &amp; community</text>`;
  const divider = `<line x1="${midX}" y1="50" x2="${midX}" y2="${H - 20}" stroke="${T.border}" stroke-width="1" stroke-dasharray="3 4"/>`;
  const inner = `${note}\n${left}\n${divider}\n${right}`;

  return svg(W, H, card(W, H, "Service Notice · Currently & Community", inner), "Currently & Community");
}

function renderStation(r, idx, colors) {
  const W = 442;
  const H = 156;
  const lang = r.lineLang;
  const color = lang ? colors.get(lang) || r.lineColor || "#8b949e" : "#8b949e";
  const desc = wrap(r.desc, 54, 2);

  const icon = lang
    ? `<circle cx="${W - 36}" cy="34" r="15" fill="${color}"/><text x="${W - 36}" y="${34 + (abbr(lang).length > 2 ? 3.5 : 4)}" text-anchor="middle" font-family="${T.mono}" font-size="${abbr(lang).length > 2 ? 8.5 : 11}" font-weight="800" fill="${ink(color)}">${esc(abbr(lang))}</text>`
    : `<circle cx="${W - 36}" cy="34" r="15" fill="#6e7681"/><text x="${W - 36}" y="38.5" text-anchor="middle" font-family="${T.sans}" font-size="13" font-weight="800" fill="#fff">×</text>`;

  const lockBadge = r.isPrivate
    ? `<g transform="translate(${W - 118},25)">
  <rect width="58" height="18" rx="9" fill="${T.bg}" stroke="${T.border}"/>
  ${lockIcon(6, 4, 9.5, T.accent)}
  <text x="19" y="12.2" font-family="${T.mono}" font-size="8" font-weight="700" fill="${T.sub}">PRIVATE</text>
</g>`
    : "";

  const orgBadge = r.showOrg && !r.masked
    ? `<text x="24" y="54" font-family="${T.mono}" font-size="9.5" fill="${T.muted}">${esc(trunc(r.owner?.login || "", 36))} /</text>`
    : "";
  const titleY = orgBadge ? 72 : 68;
  const descY = orgBadge ? 92 : 90;

  let fx = 24;
  const foot = [];
  foot.push(`<text x="${fx}" y="134" font-family="${T.mono}" font-size="10.5" fill="${T.muted}">★ ${fmt(r.stargazerCount)}</text>`);
  fx += 34 + String(fmt(r.stargazerCount)).length * 6;
  foot.push(`<text x="${fx}" y="134" font-family="${T.mono}" font-size="10.5" fill="${T.muted}">⑂ ${fmt(r.forkCount)}</text>`);
  fx += 34 + String(fmt(r.forkCount)).length * 6;
  if (lang) {
    foot.push(langChip(fx, 124, lang, color, 13));
    foot.push(`<text x="${fx + 19}" y="134" font-family="${T.mono}" font-size="10.5" fill="${T.muted}">${esc(trunc(lang, 16))}</text>`);
  }
  const dateStr = fmtMonthYear(r.activeAt);
  if (dateStr) {
    foot.push(`<text x="${W - 24}" y="134" text-anchor="end" font-family="${T.mono}" font-size="9.5" fill="${T.muted}">${esc(dateStr)}</text>`);
  }

  const inner = `${icon}${lockBadge}${orgBadge}
<text x="24" y="${titleY}" font-family="${T.mono}" font-size="14.5" font-weight="800" fill="${T.text}">${esc(trunc(r.label, 38))}</text>
${desc.map((l, i) => `<text x="24" y="${descY + i * 16}" font-family="${T.sans}" font-size="11.5" fill="${T.sub}">${esc(l)}</text>`).join("\n")}
${foot.join("\n")}`;

  return svg(W, H, card(W, H, `Station ${String(idx + 1).padStart(2, "0")}`, inner), `Station ${idx + 1}: ${r.label}`);
}

function renderLines(m) {
  const W = 900;
  const rows = m.langBars.length;
  const H = 72 + rows * 30 + 14;
  const max = Math.max(...m.langBars.map((l) => l.pct), 1);
  const bx = 200;
  const bw = 576;

  const inner = m.langBars
    .map((l, i) => {
      const y = 68 + i * 30;
      const barW = Math.max(10, (l.pct / max) * bw).toFixed(1);
      const pctText = l.pct < 1 ? `${l.pct.toFixed(1)}%` : `${Math.round(l.pct)}%`;
      return `${langChip(24, y - 8, l.name, l.color, 16)}
<text x="50" y="${y + 4.5}" font-family="${T.sans}" font-size="12.5" font-weight="700" fill="${T.text}">${esc(trunc(l.name, 18))}</text>
<rect x="${bx}" y="${y - 5}" width="${bw}" height="10" rx="5" fill="${T.track}"/>
<rect x="${bx}" y="${y - 5}" width="${barW}" height="10" rx="5" fill="${l.color}">
  <animate attributeName="width" values="0;0;${barW}" keyTimes="0;${Math.min(0.6, i * 0.07).toFixed(2)};1" dur="1.6s" fill="freeze"/>
</rect>
<text x="${W - 24}" y="${y + 4}" text-anchor="end" font-family="${T.mono}" font-size="11" fill="${T.sub}">${pctText}</text>`;
    })
    .join("\n");

  const note = `<text x="${W - 24}" y="34" text-anchor="end" font-family="${T.mono}" font-size="9" fill="${T.muted}">by bytes · public + private + orgs</text>`;
  return svg(W, H, card(W, H, "Lines", note + inner), "Languages");
}

function renderTimetable(m) {
  const W = 900;
  const H = 204;
  const cs = 13;
  const gap = 4;
  const gx = 24;
  const gy = 52;
  const lv = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

  const cells = [];
  m.weeks.forEach((w, wi) => {
    w.contributionDays.forEach((d) => {
      const dow = new Date(d.date + "T00:00:00Z").getUTCDay();
      const x = gx + wi * (cs + gap);
      const y = gy + dow * (cs + gap);
      cells.push(
        `<rect x="${x}" y="${y}" width="${cs}" height="${cs}" rx="2.5" fill="${HEAT[lv[d.contributionLevel] ?? 0]}"><title>${d.date}: ${d.contributionCount} contributions</title></rect>`
      );
    });
  });

  const sx = gx + 26 * (cs + gap) + 46;
  const stat = (y, k, v, unit = "") =>
    `<text x="${sx}" y="${y}" font-family="${T.mono}" font-size="9" font-weight="700" letter-spacing="1.4" fill="${T.muted}">${k}</text>
<text x="${sx}" y="${y + 24}" font-family="${T.sans}" font-size="21" font-weight="800" fill="${T.text}">${v}${unit ? `<tspan dx="6" font-size="14.5" font-weight="600" fill="${T.sub}">${unit}</tspan>` : ""}</text>`;

  const s = m.stats;
  const legend = HEAT.map((c, i) => `<rect x="${gx + 46 + i * 15}" y="${H - 26}" width="11" height="11" rx="2" fill="${c}"/>`).join("");

  const inner = `${cells.join("\n")}
<text x="${gx}" y="${H - 16.5}" font-family="${T.mono}" font-size="9" fill="${T.muted}">less</text>${legend}<text x="${gx + 46 + 5 * 15 + 4}" y="${H - 16.5}" font-family="${T.mono}" font-size="9" fill="${T.muted}">more</text>
${stat(64, "RUNNING FOR", s.current, s.current === 1 ? "day" : "days")}
${stat(114, "LONGEST SERVICE", s.longest, s.longest === 1 ? "day" : "days")}
${stat(164, `TRIPS IN ${s.yearNum}`, s.yearTotal.toLocaleString("en-US"), s.yearPrivate ? `(${s.yearPrivate.toLocaleString("en-US")} private)` : "")}`;

  return svg(W, H, card(W, H, "Timetable · 26 weeks", inner), "Contribution timetable");
}

// ───────────────────────────── main ─────────────────────────────
const raw = await fetchAll();
const m = processData(raw);
if (m.stats.repoTotal === 0) {
  console.error("✖ Aborting: 0 repositories returned from GitHub API. Existing SVGs were left untouched.");
  process.exit(1);
}
const avatar = await avatarData(m.user.avatarUrl);
await fs.mkdir(OUT, { recursive: true });

// Remove stale station SVGs when stationCount changes.
for (const f of await fs.readdir(OUT)) {
  if (/^station-\d+\.svg$/.test(f)) await fs.unlink(path.join(OUT, f));
}

const files = {
  "map.svg": renderMap(m, avatar),
  "interchange.svg": renderInterchange(m, avatar),
  "lines.svg": renderLines(m),
  "timetable.svg": renderTimetable(m),
};
if (config.profile?.fleet?.length) {
  files["fleet.svg"] = renderFleet(config.profile.fleet);
}
if (config.profile?.dispatch) {
  files["dispatch.svg"] = renderDispatch(config.profile.dispatch);
}
m.stations.forEach((r, i) => {
  files[`station-${i + 1}.svg`] = renderStation(r, i, m.colors);
});
for (const [f, c] of Object.entries(files)) {
  await fs.writeFile(path.join(OUT, f), c);
}

// Update the STATIONS block in README.md (2-column rows; private stations stay non-clickable).
const readmePath = path.join(ROOT, "README.md");
let readme = await fs.readFile(readmePath, "utf8").catch(() => "");
const rows = [];
for (let i = 0; i < m.stations.length; i += 2) {
  const pair = m.stations.slice(i, i + 2).map((r, offset) => {
    const idx = i + offset + 1;
    const img = `<img src="metro/station-${idx}.svg" width="49%" alt="${esc(r.label)}"/>`;
    return r.link ? `<a href="${esc(r.link)}">${img}</a>` : img;
  });
  rows.push(`<p align="center">\n  ${pair.join("\n  ")}\n</p>`);
}
readme = readme.replace(
  /(<!-- STATIONS:START -->)[\s\S]*?(<!-- STATIONS:END -->)/,
  `$1\n${rows.join("\n")}\n$2`
);
await fs.writeFile(readmePath, readme);

console.log(
  `✔ Commit Metro generated: ${m.stats.repoTotal} projects (${m.stats.repoPrivate} private, ${m.stats.orgCollabCount} org/collab), ` +
    `${m.lines.length} lines [${m.lines.map((l) => l.name).join(", ")}], ` +
    `${m.stations.length} stations, ${m.stats.yearTotal} contributions in ${m.stats.yearNum} (${m.stats.yearPrivate} private).`
);
console.log(`  Skipped: ${m.stats.skippedForks} untouched forks, ${m.stats.skippedUntouchedOrg} untouched org/collab repos.`);
console.log(`  Top langs: ${m.diagnostics.allLangSummary.join(", ")}`);
console.log(`  Largest repos (KB): ${m.diagnostics.topReposByBytes.map((r) => `${r.name}=${r.kb}KB`).join(", ")}`);
if (m.stats.repoPrivate === 0 && m.stats.yearPrivate > 0) {
  console.warn(
    `⚠ Detected ${m.stats.yearPrivate} private contributions, but 0 private repos were accessible with this token.\n` +
      `  Add secret METRO_TOKEN (Classic PAT with scopes: repo, read:user, read:org) in repo Settings -> Secrets -> Actions.`
  );
}
