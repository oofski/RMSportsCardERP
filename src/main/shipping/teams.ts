/**
 * RM Cardz Shipping Workspace — team-name matching (architecture doc section 3).
 *
 * `createTeamMatcher(sport)` binds a matcher to ONE league's canonical slate.
 * `matchTeam(raw)` resolves in a fixed precedence:
 *
 *   1. exact          — normalized key equality against the canonical slate
 *   2. alias          — relocations / renames / common short forms
 *   3. suffix         — the candidate's LAST words are exactly a canonical team
 *                       ("Oakland Athletics" -> "Athletics", "the Dallas
 *                       Cowboys" -> "Dallas Cowboys"). Longest canonical suffix
 *                       wins; an ambiguous same-length tie is refused.
 *   4. mascot         — a 1-2 word candidate that is the unique tail of exactly
 *                       one canonical team in this league ("Cowboys").
 *   5. fuzzy          — Levenshtein <= 2 to the nearest canonical name, WITH the
 *                       cross-league guard: a raw that is an exact team (or
 *                       alias, or unambiguous mascot) in a DIFFERENT league is
 *                       never snapped. "New York Mets" is edit-distance 1 from
 *                       "New York Jets"; an NFL-bound matcher must leave it a
 *                       warning rather than put a Mets card in a Jets slot.
 *
 * Nothing here touches I/O — the whole module is pure so the parser stays
 * unit-testable with synthetic strings.
 */

import type { ShipSport } from '@shared/shippingTypes'
import { SHIP_SPORTS } from '@shared/shippingTypes'

// ---------------------------------------------------------------------------
// Canonical slates
// ---------------------------------------------------------------------------

const NFL_TEAMS: readonly string[] = [
  'Arizona Cardinals',
  'Atlanta Falcons',
  'Baltimore Ravens',
  'Buffalo Bills',
  'Carolina Panthers',
  'Chicago Bears',
  'Cincinnati Bengals',
  'Cleveland Browns',
  'Dallas Cowboys',
  'Denver Broncos',
  'Detroit Lions',
  'Green Bay Packers',
  'Houston Texans',
  'Indianapolis Colts',
  'Jacksonville Jaguars',
  'Kansas City Chiefs',
  'Las Vegas Raiders',
  'Los Angeles Chargers',
  'Los Angeles Rams',
  'Miami Dolphins',
  'Minnesota Vikings',
  'New England Patriots',
  'New Orleans Saints',
  'New York Giants',
  'New York Jets',
  'Philadelphia Eagles',
  'Pittsburgh Steelers',
  'San Francisco 49ers',
  'Seattle Seahawks',
  'Tampa Bay Buccaneers',
  'Tennessee Titans',
  'Washington Commanders'
]

const MLB_TEAMS: readonly string[] = [
  'Arizona Diamondbacks',
  'Athletics',
  'Atlanta Braves',
  'Baltimore Orioles',
  'Boston Red Sox',
  'Chicago Cubs',
  'Chicago White Sox',
  'Cincinnati Reds',
  'Cleveland Guardians',
  'Colorado Rockies',
  'Detroit Tigers',
  'Houston Astros',
  'Kansas City Royals',
  'Los Angeles Angels',
  'Los Angeles Dodgers',
  'Miami Marlins',
  'Milwaukee Brewers',
  'Minnesota Twins',
  'New York Mets',
  'New York Yankees',
  'Philadelphia Phillies',
  'Pittsburgh Pirates',
  'San Diego Padres',
  'San Francisco Giants',
  'Seattle Mariners',
  'St. Louis Cardinals',
  'Tampa Bay Rays',
  'Texas Rangers',
  'Toronto Blue Jays',
  'Washington Nationals'
]

const NBA_TEAMS: readonly string[] = [
  'Atlanta Hawks',
  'Boston Celtics',
  'Brooklyn Nets',
  'Charlotte Hornets',
  'Chicago Bulls',
  'Cleveland Cavaliers',
  'Dallas Mavericks',
  'Denver Nuggets',
  'Detroit Pistons',
  'Golden State Warriors',
  'Houston Rockets',
  'Indiana Pacers',
  'LA Clippers',
  'Los Angeles Lakers',
  'Memphis Grizzlies',
  'Miami Heat',
  'Milwaukee Bucks',
  'Minnesota Timberwolves',
  'New Orleans Pelicans',
  'New York Knicks',
  'Oklahoma City Thunder',
  'Orlando Magic',
  'Philadelphia 76ers',
  'Phoenix Suns',
  'Portland Trail Blazers',
  'Sacramento Kings',
  'San Antonio Spurs',
  'Toronto Raptors',
  'Utah Jazz',
  'Washington Wizards'
]

const NHL_TEAMS: readonly string[] = [
  'Anaheim Ducks',
  'Boston Bruins',
  'Buffalo Sabres',
  'Calgary Flames',
  'Carolina Hurricanes',
  'Chicago Blackhawks',
  'Colorado Avalanche',
  'Columbus Blue Jackets',
  'Dallas Stars',
  'Detroit Red Wings',
  'Edmonton Oilers',
  'Florida Panthers',
  'Los Angeles Kings',
  'Minnesota Wild',
  'Montreal Canadiens',
  'Nashville Predators',
  'New Jersey Devils',
  'New York Islanders',
  'New York Rangers',
  'Ottawa Senators',
  'Philadelphia Flyers',
  'Pittsburgh Penguins',
  'San Jose Sharks',
  'Seattle Kraken',
  'St. Louis Blues',
  'Tampa Bay Lightning',
  'Toronto Maple Leafs',
  'Utah Mammoth',
  'Vancouver Canucks',
  'Vegas Golden Knights',
  'Washington Capitals',
  'Winnipeg Jets'
]

export const SHIP_TEAM_LISTS: Record<ShipSport, readonly string[]> = {
  nfl: NFL_TEAMS,
  mlb: MLB_TEAMS,
  nba: NBA_TEAMS,
  nhl: NHL_TEAMS
}

/**
 * Every team in every league, by normalized key. Built on FIRST USE, not at
 * module load.
 *
 * `ALIASES` is a `const` declared further down this file, so touching it from a
 * top-level initializer here throws on its temporal dead zone — and it throws at
 * import time, which takes the whole main process with it. Deferring costs one
 * branch per call and removes the ordering question entirely.
 */
let allTeamKeys: ReadonlySet<string> | null = null

function teamKeySet(): ReadonlySet<string> {
  if (!allTeamKeys) {
    allTeamKeys = new Set([
      ...Object.values(SHIP_TEAM_LISTS).flatMap((list) => list.map((t) => normalizeTeamKey(t))),
      // The ALIASES are not optional politeness here, they are most of the real
      // data. On two months of RM's ledger the canonical-only set missed every
      // "Oakland Athletics" (the club moved), every "LA Lakers" and every
      // "Philadelphia Sixers" — and each miss read as a marketplace sale, which
      // is a break spot booked as a sealed box and a phantom product to match.
      ...Object.values(ALIASES).flatMap((m) => Object.keys(m))
    ])
  }
  return allTeamKeys
}

/**
 * Is this the name of a real team, in any league?
 *
 * Canonical names and aliases, on the normalized key. Deliberately NOT fuzzy and
 * NOT mascot-alone: the caller is deciding whether a sale is a break spot, and a
 * product legitimately named after a place or an animal ("Cactus Jack",
 * "Cosmic") must not be dragged into the wrong bucket by a near-miss.
 *
 * League-blind, which is the opposite of what `createTeamMatcher` wants and
 * exactly right here. The matcher places a card in a slot, so it must refuse to
 * read "New York Mets" as a Jet. This only answers "is that a team at all", for
 * a ledger line whose league nobody declared.
 */
export function isAnyLeagueTeam(raw: string): boolean {
  const key = normalizeTeamKey(raw)
  return key.length > 0 && teamKeySet().has(key)
}

/** The full slate size used by the fidelity audit (32 NFL/NHL, 30 MLB/NBA). */
export const SHIP_TEAM_SLATE_SIZE: Record<ShipSport, number> = {
  nfl: NFL_TEAMS.length,
  mlb: MLB_TEAMS.length,
  nba: NBA_TEAMS.length,
  nhl: NHL_TEAMS.length
}

/**
 * Relocations, renames and the short forms that actually show up on a Whatnot
 * breaking slip. Keys are matched against the NORMALIZED candidate, so write
 * them the way `normalizeTeamKey` would produce ("st louis rams", "oakland a s").
 */
const ALIASES: Record<ShipSport, Record<string, string>> = {
  nfl: {
    'washington football team': 'Washington Commanders',
    'washington redskins': 'Washington Commanders',
    'oakland raiders': 'Las Vegas Raiders',
    'san diego chargers': 'Los Angeles Chargers',
    'st louis rams': 'Los Angeles Rams',
    'saint louis rams': 'Los Angeles Rams',
    niners: 'San Francisco 49ers',
    '49 ers': 'San Francisco 49ers',
    'sf 49ers': 'San Francisco 49ers',
    'ny giants': 'New York Giants',
    'ny jets': 'New York Jets',
    'la rams': 'Los Angeles Rams',
    'la chargers': 'Los Angeles Chargers',
    'kc chiefs': 'Kansas City Chiefs',
    'tb buccaneers': 'Tampa Bay Buccaneers',
    'ne patriots': 'New England Patriots',
    'gb packers': 'Green Bay Packers'
  },
  mlb: {
    'oakland athletics': 'Athletics',
    'las vegas athletics': 'Athletics',
    'oakland as': 'Athletics',
    'oakland a s': 'Athletics',
    'a s': 'Athletics',
    'cleveland indians': 'Cleveland Guardians',
    'florida marlins': 'Miami Marlins',
    'tampa bay devil rays': 'Tampa Bay Rays',
    'anaheim angels': 'Los Angeles Angels',
    'los angeles angels of anaheim': 'Los Angeles Angels',
    'ny yankees': 'New York Yankees',
    'ny mets': 'New York Mets',
    'la dodgers': 'Los Angeles Dodgers',
    'la angels': 'Los Angeles Angels',
    'sf giants': 'San Francisco Giants',
    'sd padres': 'San Diego Padres',
    'd backs': 'Arizona Diamondbacks',
    dbacks: 'Arizona Diamondbacks',
    diamondbacks: 'Arizona Diamondbacks'
  },
  nba: {
    'los angeles clippers': 'LA Clippers',
    'la clippers': 'LA Clippers',
    'la lakers': 'Los Angeles Lakers',
    'new jersey nets': 'Brooklyn Nets',
    'seattle supersonics': 'Oklahoma City Thunder',
    'charlotte bobcats': 'Charlotte Hornets',
    'ny knicks': 'New York Knicks',
    'okc thunder': 'Oklahoma City Thunder',
    'portland trailblazers': 'Portland Trail Blazers',
    'philadelphia sixers': 'Philadelphia 76ers',
    sixers: 'Philadelphia 76ers',
    '76 ers': 'Philadelphia 76ers'
  },
  nhl: {
    'utah hockey club': 'Utah Mammoth',
    'arizona coyotes': 'Utah Mammoth',
    'phoenix coyotes': 'Utah Mammoth',
    'las vegas golden knights': 'Vegas Golden Knights',
    'ny rangers': 'New York Rangers',
    'ny islanders': 'New York Islanders',
    'nj devils': 'New Jersey Devils',
    'tb lightning': 'Tampa Bay Lightning',
    'la kings': 'Los Angeles Kings',
    'st louis blues': 'St. Louis Blues',
    'saint louis blues': 'St. Louis Blues'
  }
}

// ---------------------------------------------------------------------------
// Normalization + edit distance
// ---------------------------------------------------------------------------

/**
 * Lowercase, strip diacritics ("Montréal" -> "montreal"), replace every
 * non-alphanumeric run with a single space, collapse and trim.
 */
export function normalizeTeamKey(raw: string): string {
  if (!raw) return ''
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Levenshtein distance with an early cutoff. Returns `max + 1` as soon as the
 * distance is known to exceed `max`, so the fuzzy step stays cheap.
 */
export function levenshtein(a: string, b: string, max = Number.MAX_SAFE_INTEGER): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  if (!a.length) return b.length
  if (!b.length) return a.length

  let prev = new Array<number>(b.length + 1)
  let cur = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    let rowMin = cur[0]
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      const v = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
      cur[j] = v
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return max + 1
    const swap = prev
    prev = cur
    cur = swap
  }
  return prev[b.length]
}

// ---------------------------------------------------------------------------
// Per-league index
// ---------------------------------------------------------------------------

interface LeagueIndex {
  sport: ShipSport
  teams: readonly string[]
  /** normalized canonical name -> canonical name */
  exact: Map<string, string>
  /** normalized alias -> canonical name */
  alias: Map<string, string>
  /** unambiguous trailing phrase ("cowboys", "red sox") -> canonical name */
  mascot: Map<string, string>
  /** every key that identifies a team in this league with certainty */
  certain: Set<string>
}

const INDEX_CACHE = new Map<ShipSport, LeagueIndex>()

function buildIndex(sport: ShipSport): LeagueIndex {
  const teams = SHIP_TEAM_LISTS[sport]
  const exact = new Map<string, string>()
  for (const team of teams) exact.set(normalizeTeamKey(team), team)

  const alias = new Map<string, string>()
  for (const [key, team] of Object.entries(ALIASES[sport])) {
    const k = normalizeTeamKey(key)
    if (k && !exact.has(k)) alias.set(k, team)
  }

  // Every proper suffix of every canonical name; keep only the ones that point
  // at exactly one team ("sox" is shared by Red Sox / White Sox -> dropped,
  // "red sox" is unique -> kept).
  const suffixes = new Map<string, Set<string>>()
  for (const team of teams) {
    const words = normalizeTeamKey(team).split(' ')
    for (let i = 1; i < words.length; i++) {
      const key = words.slice(i).join(' ')
      let bucket = suffixes.get(key)
      if (!bucket) {
        bucket = new Set<string>()
        suffixes.set(key, bucket)
      }
      bucket.add(team)
    }
  }
  const mascot = new Map<string, string>()
  for (const [key, bucket] of suffixes) {
    if (bucket.size === 1 && !exact.has(key)) mascot.set(key, [...bucket][0])
  }

  const certain = new Set<string>([...exact.keys(), ...alias.keys(), ...mascot.keys()])
  return { sport, teams, exact, alias, mascot, certain }
}

function getIndex(sport: ShipSport): LeagueIndex {
  let idx = INDEX_CACHE.get(sport)
  if (!idx) {
    idx = buildIndex(sport)
    INDEX_CACHE.set(sport, idx)
  }
  return idx
}

/**
 * The cross-league guard (robustness rule 7): true when `key` names a team in
 * some league OTHER than `sport` with certainty. Such a name is never fuzzed
 * into this league's slate.
 */
function isCertainInAnotherLeague(sport: ShipSport, key: string): boolean {
  for (const other of SHIP_SPORTS) {
    if (other === sport) continue
    if (getIndex(other).certain.has(key)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// The matcher
// ---------------------------------------------------------------------------

export type TeamMatchMethod = 'exact' | 'alias' | 'suffix' | 'mascot' | 'fuzzy'

export interface TeamMatch {
  /** The canonical team name, or null when nothing resolved. */
  team: string | null
  method: TeamMatchMethod | null
  raw: string
  /** Edit distance, only set for `fuzzy`. */
  distance?: number
}

export interface TeamMatcher {
  sport: ShipSport
  /** The canonical slate for this league. */
  teams: readonly string[]
  /** Full slate size — the audit's `maxTeams`. */
  maxTeams: number
  matchTeam(raw: string): TeamMatch
  /** Convenience: the canonical name or null. */
  canonical(raw: string): string | null
}

const MAX_FUZZY_DISTANCE = 2
const MIN_FUZZY_LENGTH = 4

function noMatch(raw: string): TeamMatch {
  return { team: null, method: null, raw }
}

export function createTeamMatcher(sport: ShipSport): TeamMatcher {
  const idx = getIndex(sport)

  const matchTeam = (rawInput: string): TeamMatch => {
    const raw = (rawInput ?? '').trim()
    if (!raw) return noMatch(raw)
    const key = normalizeTeamKey(raw)
    if (!key) return noMatch(raw)

    // 1. exact
    const exact = idx.exact.get(key)
    if (exact) return { team: exact, method: 'exact', raw }

    // 2. alias
    const alias = idx.alias.get(key)
    if (alias) return { team: alias, method: 'alias', raw }

    // 3. trailing phrase / city prefix — longest canonical suffix wins, an
    //    ambiguous same-length tie is refused.
    const words = key.split(' ')
    let suffixTeam: string | null = null
    let suffixLen = 0
    let suffixAmbiguous = false
    for (const [canonKey, team] of idx.exact) {
      const canonWords = canonKey.split(' ')
      if (canonWords.length >= words.length) continue
      if (words.slice(words.length - canonWords.length).join(' ') !== canonKey) continue
      if (canonWords.length > suffixLen) {
        suffixTeam = team
        suffixLen = canonWords.length
        suffixAmbiguous = false
      } else if (canonWords.length === suffixLen && team !== suffixTeam) {
        suffixAmbiguous = true
      }
    }
    if (suffixTeam && !suffixAmbiguous) return { team: suffixTeam, method: 'suffix', raw }

    // 4. bare mascot ("Cowboys", "Red Sox") — only for short candidates, and
    //    only when it is unique inside this league.
    if (words.length <= 2) {
      const mascot = idx.mascot.get(key)
      if (mascot) return { team: mascot, method: 'mascot', raw }
    }

    // 5. fuzzy, behind the cross-league guard
    if (key.length < MIN_FUZZY_LENGTH) return noMatch(raw)
    if (isCertainInAnotherLeague(sport, key)) return noMatch(raw)

    let bestTeam: string | null = null
    let bestDistance = MAX_FUZZY_DISTANCE + 1
    let tie = false
    for (const [canonKey, team] of idx.exact) {
      const d = levenshtein(key, canonKey, MAX_FUZZY_DISTANCE)
      if (d > MAX_FUZZY_DISTANCE) continue
      if (d < bestDistance) {
        bestDistance = d
        bestTeam = team
        tie = false
      } else if (d === bestDistance && team !== bestTeam) {
        tie = true
      }
    }
    if (bestTeam && !tie) return { team: bestTeam, method: 'fuzzy', raw, distance: bestDistance }

    return noMatch(raw)
  }

  return {
    sport,
    teams: idx.teams,
    maxTeams: SHIP_TEAM_SLATE_SIZE[sport],
    matchTeam,
    canonical: (raw: string) => matchTeam(raw).team
  }
}

/**
 * A matcher that never resolves anything. Used for the auto-detection harvest
 * pass, where candidates are collected BEFORE the league is known.
 */
export function createNullTeamMatcher(): TeamMatcher {
  return {
    sport: 'nfl',
    teams: [],
    maxTeams: 0,
    matchTeam: (raw: string) => noMatch((raw ?? '').trim()),
    canonical: () => null
  }
}

// ---------------------------------------------------------------------------
// League auto-detection
// ---------------------------------------------------------------------------

export interface SportDetection {
  sport: ShipSport
  scores: Record<ShipSport, number>
}

/**
 * Score every league over all candidate team strings — an exact/alias hit is
 * worth 100, a suffix/mascot hit 10, a fuzzy hit 1 — and pick the winner. Ties
 * fall back to the first league in `SHIP_SPORTS` order, so detection is
 * deterministic. Run this ONCE over every team string in the upload.
 */
export function detectSportDetailed(candidates: Iterable<string>): SportDetection {
  const list: string[] = []
  for (const c of candidates) {
    const t = (c ?? '').trim()
    if (t) list.push(t)
  }
  const scores = { nfl: 0, mlb: 0, nba: 0, nhl: 0 } as Record<ShipSport, number>
  for (const sport of SHIP_SPORTS) {
    const matcher = createTeamMatcher(sport)
    let score = 0
    for (const candidate of list) {
      const m = matcher.matchTeam(candidate)
      if (m.method === 'exact' || m.method === 'alias') score += 100
      else if (m.method === 'suffix' || m.method === 'mascot') score += 10
      else if (m.method === 'fuzzy') score += 1
    }
    scores[sport] = score
  }
  let winner: ShipSport = SHIP_SPORTS[0]
  for (const sport of SHIP_SPORTS) {
    if (scores[sport] > scores[winner]) winner = sport
  }
  return { sport: winner, scores }
}

export function detectSport(candidates: Iterable<string>): ShipSport {
  return detectSportDetailed(candidates).sport
}

/**
 * How much evidence a slate is allowed to be inferred from.
 *
 * 100 is one exact-or-alias team name. Below that the only things that can score
 * are a mascot (10) and a fuzzy near-miss (1), and neither identifies a league
 * on its own: "Giants" is a football team AND a baseball team, "Rangers" is
 * hockey and baseball, "Cardinals" is football and baseball, "Panthers" is
 * football and hockey. Ten mascots also reach 100, which is the deliberate
 * second way in — a break whose slips only ever say "Cubs", "Mets", "Astros" is
 * ten independent votes, not one guess repeated.
 */
export const SLATE_DETECTION_MIN_SCORE = 100

export interface SlateDetection {
  sport: ShipSport
  /** 32 for NFL and NHL, 30 for MLB and NBA. */
  slateSize: number
  /** The winning league's score, so a caller can report HOW confident. */
  score: number
}

/**
 * The league's roster size for a set of team strings, or NULL when the evidence
 * does not support one.
 *
 * `detectSport` ALWAYS returns a league. It has to — it is used where something
 * must be picked, and it falls back to the first entry in `SHIP_SPORTS` on a
 * tie, which means a set of strings containing no team at all comes back as
 * 'nfl' with a score of zero. Costing a break off that answer bills 32 team bags
 * against a night nobody can identify, and nothing on the screen would look
 * wrong: 32 is a number of exactly the right shape in exactly the right column.
 *
 * So this refuses twice. Once on weight — see `SLATE_DETECTION_MIN_SCORE` — and
 * once on ambiguity: a rival league tied on score whose slate is a DIFFERENT
 * SIZE means the answer changes the money, and a coin toss must not. A tie
 * between MLB and NBA is not refused, because both are 30 and the caller is
 * asking for a slate size rather than for a league.
 */
export function detectSlate(candidates: Iterable<string>): SlateDetection | null {
  const { sport, scores } = detectSportDetailed(candidates)
  const score = scores[sport]
  if (score < SLATE_DETECTION_MIN_SCORE) return null
  const slateSize = SHIP_TEAM_SLATE_SIZE[sport]
  for (const other of SHIP_SPORTS) {
    if (other === sport) continue
    // `detectSportDetailed` breaks ties by SHIP_SPORTS order, so anything
    // scoring as high as the winner IS tied with it.
    if (scores[other] >= score && SHIP_TEAM_SLATE_SIZE[other] !== slateSize) return null
  }
  return { sport, slateSize, score }
}
