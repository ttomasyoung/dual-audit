#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Terminal-state distribution for the dual-audit panel -- v6.

WHY v6 EXISTS: v3, v4 and v5 were each rejected by an independent reviewer.

  v3  The unit of measurement was not the same thing on both sides of the split variable:
      under hand-carried orchestration one invocation is one ROUND, under the driver one
      invocation is an ENTIRE multi-round audit. "Zero convergences" was then guaranteed by
      the architecture, not evidence about the panel's health.

  v4  THE POPULATION RULE EXCLUDED THE COUNTEREXAMPLES. A whitelist admitted only
      dual-audit-panel / dual-audit-run, so panel-r2-driver / dual-audit-r2-relay /
      reaudit-relaunch were all dropped -- and those are precisely the round-two hand-offs.
      "The hand-off never happened" was manufactured by the author's own selection rule.

  v5  A HAND-OFF MARKER WAS READ AS AN ABSENCE MARKER. The state `rN_pending_codex` means
      "this round's Claude side is done; the caller must now run codex" -- the source comment
      says "never converged until the main loop runs codex for THIS round" and the state
      carries a codex_brief; the driver recognises it and runs the codex side. v5's classify()
      read any pending_codex as "second reviewer absent", the opposite of its meaning.
      Consequence: hand-carried second-side non-delivery was reported as 24/26 = 92.3%.

  The pattern common to all three: EACH TIME THE AUTHOR DEFINED THE CRITERION, AND EACH
  DEFINITION HAPPENED TO SUPPORT THE STORY. None was an arithmetic slip; all three were
  misreadings, and all three erred in the direction of making the system look worse.

WHAT v6 CHANGES IS THE STRUCTURE THAT PRODUCED THE ERROR, NOT THE PARAMETERS:
  (1) Population: a mechanical, deliberately over-inclusive rule (name looks like an audit or
      panel, or the return carries panel terminal-state fields) instead of a whitelist.
      Over-inclusion is the safe direction: it cannot exclude a counterexample.
  (2) Freeze boundaries are not chosen; several are reported together.
  (3) "Did the second side turn up" is decided by DELIVERY EVIDENCE, not by the status string:
      does a genuinely RETURNED codex verdict block exist in the corpus. A status string is the
      orchestration layer's intent, not a fact.
  (4) The criterion is CALIBRATED IN BOTH DIRECTIONS: bad examples must be rejected AND good
      examples must not be. The first arm alone is not enough -- v5's check rejected bad input
      correctly and still produced the wrong conclusion.
  (5) Proportions carry Wilson 95% intervals; no point estimate is reported as a conclusion.

DELIVERY CRITERION (strict; see verdict_blocks):
  * RETURNED VALUES ONLY: toolUseResult / tool_result in the session jsonl, and type:"result"
    in the workflow journal. NEVER a brief -- a codex brief states in plain text "your verdict
    must carry AUDIT-ID: fp_X_rN", so keyword matching would read the statement of work as a verdict.
  * VERDICT must be a single value; a template echo such as `APPROVE | ... | REJECT` is refused.
  * AUDIT-ID must be followed immediately by the block terminator: `END`, or `__CODEX_RC=<n>` /
    `__DUAL_AUDIT_RC=<n>` then `END`. Both RC marker names are accepted -- the production wrapper
    emits __CODEX_RC, the released package emits __DUAL_AUDIT_RC.
  * Verdicts land in TWO places: the session jsonl and the workflow journal. Checking only one
    misses deliveries; v6 checks both.

OLD TRAPS STILL DELIBERATELY AVOIDED:
  * tool results inside jsonl are escaped JSON strings; grepping the unescaped form returns a false 0
  * the result JSON's "task" field contains the task text, so a greedy regex captures the task
    description rather than the terminal state
  * truncation in the notification layer does not mean the terminal state is unrecoverable; the
    state fields usually precede the truncation point
  * only top-level fields decide the terminal state; calls[] / driver_trace[] are per-round
    intermediate states and are not used for it

USAGE:
  python3 analyze_runs.py [--cut YYYY-MM-DD] [--since YYYY-MM-DD] [--cuts d1,d2,...]
  Defaults reproduce the frozen 2026-07-28 report.   # sanitize-scan:allow (a freeze date, not incident history: the number is meaningless without the window it was taken over)
"""
import json, glob, re, os, html, collections, datetime, math

# --root points the extraction at a FROZEN COPY of the corpus instead of the live session
# directory. This exists because the live corpus is deleted on the host's retention schedule:
# measured 2026-08-25, two runs 62 minutes apart over the same freeze date returned n=238 and   # sanitize-scan:allow (measurement provenance)
# n=222. A table computed against a directory that shrinks under it is not reproducible by
# anybody, including its authors, so the paper's numbers are computed against the archive.
ROOT = os.path.expanduser('~/.claude/projects')

NAME_RE = re.compile(r'dual-audit|panel|reaudit|audit-|-audit|adversarial', re.I)
PANEL_FIELDS = {'convergence_status', 'audit_stage', 'task_fingerprint', 'rounds_run', 'panel_calls'}
CUTS = ['2026-07-25', '2026-07-27', '2026-07-28', '2026-07-29']   # sanitize-scan:allow (freeze-date constants; this script cannot exist without dates)
MAIN_CUT = '2026-07-28'   # sanitize-scan:allow (freeze-date constant)
# Window overrides. Defaults reproduce that frozen report byte for byte, so
# adding these cannot silently move a published number; an era column has to be asked for.
# --since is a LOWER bound (inclusive), --cut the freeze date (exclusive upper bound).
import sys as _sys
def _arg(flag, default=None):
    if flag in _sys.argv:
        return _sys.argv[_sys.argv.index(flag) + 1]
    return default
_cut = _arg('--cut')
if _cut:
    MAIN_CUT = _cut
    if _cut not in CUTS:
        CUTS = CUTS + [_cut]
_cuts = _arg('--cuts')
if _cuts:
    CUTS = _cuts.split(',')
SINCE_RAW = _arg('--since')
_root = _arg('--root')
if _root:
    ROOT = os.path.abspath(os.path.expanduser(_root))


WINDOW_H = 2
# (7) ORIGIN. The panel does not only run on the production path: a smoke-harness the authors
#     run to exercise the RELEASED PACKAGE leaves records identical in shape, and its failures are
#     deliberately induced. Pooling the two counts those induced failures as panel health. This was
#     the fourth time this script's population was found unclean, in the same pattern as the first
#     three: THE POPULATION THE AUTHOR DEFINED HAPPENED TO SUPPORT THE STORY (here, by making the
#     system look worse). So all three splits are reported and none is chosen.
PROD_PREFIX = os.path.expanduser('~/.claude/workflows/')


def origin_of(sp):
    if not sp:
        return 'scriptPath not recorded'
    if sp.startswith(PROD_PREFIX):
        return 'production'
    if '/tmp/' in sp:
        return '[!] packaging smoke-harness'
    if '/.claude/projects/' in sp:
        return 'inline snapshot'
    return 'other'

# ---- (3) DELIVERY CRITERION ---------------------------------------------------
# After AUDIT-ID one RC marker line is allowed, then the block terminator END must follow.
# Nothing else may be inserted between them.
DELIVERED_RE = re.compile(
    r'AUDIT-ID[^\w]{0,6}([A-Za-z0-9_]+?)_r(\d)\s*'
    r'(?:__(?:CODEX|DUAL_AUDIT)_RC\s*=\s*\d+\s*)?'
    r'(?:[^\n]{0,40}\n\s*){0,2}?'
    r'END\b', re.S)
TEMPLATE_RE = re.compile(r'VERDICT:\s*[A-Z_]+\s*\|')   # "VERDICT: APPROVE | REJECT" = template echo
# Legacy shape (before the fingerprint/AUDIT-ID scheme existed): only the block itself is available
NOID_RE = re.compile(r'VERDICT:\s*[A-Z_]+\b.{0,6000}?\bEND\b', re.S)


def verdict_blocks(text):
    """Extract (fingerprint, round) from a RETURNED value. Genuine verdict blocks only."""
    if not text or 'AUDIT-ID' not in text:
        return []
    s = text.replace('\\n', '\n').replace('\\"', '"')
    if 'VERDICT' not in s or TEMPLATE_RE.search(s):
        return []
    return [(m.group(1), int(m.group(2))) for m in DELIVERED_RE.finditer(s)]


def has_noid_verdict(text):
    """Legacy verdict block: a single-valued VERDICT and a closing END, but no AUDIT-ID.
       Used ONLY on the return value of a Bash call whose command contained the reviewer CLI --
       otherwise verdicts from the other side would be counted too."""
    if not text or 'VERDICT' not in text:
        return False
    s = text.replace('\\n', '\n').replace('\\"', '"')
    return bool(NOID_RE.search(s)) and not TEMPLATE_RE.search(s)


def result_texts(o):
    """Returned values only. Outgoing tool_use payloads are never read."""
    out = []
    t = o.get('toolUseResult')
    if isinstance(t, str):
        out.append(t)
    elif isinstance(t, dict):
        out.append(json.dumps(t, ensure_ascii=False))
    m = o.get('message')
    if isinstance(m, dict) and m.get('role') == 'user' and isinstance(m.get('content'), list):
        for b in m['content']:
            if isinstance(b, dict) and b.get('type') == 'tool_result':
                c = b.get('content')
                out.append(c if isinstance(c, str) else json.dumps(c, ensure_ascii=False))
    return out


def walk_strings(x):
    if isinstance(x, dict):
        for v in x.values():
            yield from walk_strings(v)
    elif isinstance(x, list):
        for v in x:
            yield from walk_strings(v)
    elif isinstance(x, str):
        yield x


def top_level_fields(s):
    """Truncation-tolerant top-level field scanner. Nested objects are skipped whole; it never
       descends into calls[] or driver_trace[], which hold per-round intermediate states."""
    i = s.find('{')
    if i < 0:
        return None
    out, n, i = {}, len(s), i + 1
    while i < n:
        c = s[i]
        if c in ' \t\r\n,':
            i += 1; continue
        if c == '}':
            break
        if c != '"':
            return out or None
        j, key = i + 1, []
        while j < n:
            if s[j] == '\\':
                key.append(s[j:j + 2]); j += 2; continue
            if s[j] == '"':
                break
            key.append(s[j]); j += 1
        if j >= n:
            break
        k = ''.join(key); j += 1
        while j < n and s[j] in ' \t\r\n':
            j += 1
        if j >= n or s[j] != ':':
            break
        j += 1
        while j < n and s[j] in ' \t\r\n':
            j += 1
        if j >= n:
            break
        if s[j] in '{[':
            depth, instr, esc = 0, False, False
            while j < n:
                ch = s[j]
                if instr:
                    if esc: esc = False
                    elif ch == '\\': esc = True
                    elif ch == '"': instr = False
                elif ch == '"': instr = True
                elif ch in '{[': depth += 1
                elif ch in '}]':
                    depth -= 1
                    if depth == 0:
                        j += 1; break
                j += 1
        elif s[j] == '"':
            j += 1; buf = []
            while j < n:
                if s[j] == '\\':
                    buf.append(s[j:j + 2]); j += 2; continue
                if s[j] == '"':
                    j += 1; break
                buf.append(s[j]); j += 1
            try:
                out[k] = json.loads('"' + ''.join(buf) + '"')
            except json.JSONDecodeError:
                out[k] = ''.join(buf)
        else:
            st = j
            while j < n and s[j] not in ',}':
                j += 1
            tok = s[st:j].strip()
            out[k] = {'true': True, 'false': False, 'null': None}.get(tok, tok)
        i = j
    return out or None


def parse_result(raw):
    if raw is None:
        return None
    s = html.unescape(raw).strip()
    if re.search(r'\(truncated\s+[\d,]+\s+chars', s):
        f = top_level_fields(s)
        return f if (f and (PANEL_FIELDS & set(f) or 'converged' in f or 'error' in f)) else None
    dec = json.JSONDecoder(strict=False)
    first = s.find('{')
    order = ([first] if first >= 0 else []) + [i for i, c in enumerate(s) if c == '{' and i != first]
    for i in order:
        try:
            obj, _ = dec.raw_decode(s, i)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(obj, dict) and obj:
            if set(obj.keys()) <= {'type', 'text'} and isinstance(obj.get('text'), str):
                inner = parse_result(obj['text'])
                if inner is not None:
                    return inner
                continue
            return obj
    return top_level_fields(s)


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h) * 100, min(1.0, c + h) * 100)


# ---- SCAN ---------------------------------------------------------------------
launches, notifs = {}, {}
stats = collections.Counter()
delivered = collections.defaultdict(set)          # fingerprint -> {rounds}
sess_codex = collections.defaultdict(list)        # session file -> [times a reviewer verdict returned]
run_delivered = collections.defaultdict(set)      # runId -> {rounds}; used when the top-level result was truncated

for path in glob.glob(os.path.join(ROOT, '*', '*.jsonl')):
    stats['files_scanned'] += 1
    try:
        fh = open(path, encoding='utf-8', errors='replace')
    except OSError:
        stats['files_unreadable'] += 1; continue
    with fh:
        codex_calls = set()   # tool_use_ids in this session whose command invoked the reviewer CLI
        for line in fh:
            interesting = ('local_workflow' in line or '<task-notification>' in line
                           or 'AUDIT-ID' in line or 'VERDICT' in line or 'codex' in line)
            if not interesting:
                continue
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                stats['json_line_parse_failed'] += 1; continue

            tr = o.get('toolUseResult')
            if isinstance(tr, dict) and tr.get('taskType') == 'local_workflow':
                tid = tr.get('taskId')
                if tid and tid not in launches:
                    launches[tid] = {'name': tr.get('workflowName') or '',
                                     'ts': o.get('timestamp'), 'file': path,
                                     'run': tr.get('runId'),
                                     'sp': str(tr.get('scriptPath') or '')}

            # Record reviewer-CLI Bash calls, so legacy verdicts (no AUDIT-ID) can be attributed
            m0 = o.get('message')
            if isinstance(m0, dict) and isinstance(m0.get('content'), list):
                for b in m0['content']:
                    if (isinstance(b, dict) and b.get('type') == 'tool_use'
                            and b.get('name') == 'Bash'):
                        cmd = (b.get('input') or {}).get('command') or ''
                        if 'codex' in cmd:
                            codex_calls.add(b.get('id'))

            if '<task-notification>' in line:
                for s in walk_strings(o):
                    if '<task-notification>' not in s:
                        continue
                    for m in re.finditer(r'<task-notification>(.*?)</task-notification>', s, re.S):
                        blk = m.group(1)
                        t = re.search(r'<task-id>([^<]+)</task-id>', blk)
                        if not t or t.group(1) in notifs:
                            continue
                        r = re.search(r'<result>(.*?)</result>', blk, re.S)
                        notifs[t.group(1)] = r.group(1) if r else None

            # (3) Delivery evidence is extracted from returned values only
            got = False
            if 'AUDIT-ID' in line:
                for s in result_texts(o):
                    for fp, rnd in verdict_blocks(s):
                        delivered[fp].add(rnd); got = True
            # Legacy: this return belongs to a reviewer-CLI command and carries a full VERDICT..END block
            if not got and 'VERDICT' in line and isinstance(m0, dict) \
                    and m0.get('role') == 'user' and isinstance(m0.get('content'), list):
                for b in m0['content']:
                    if (isinstance(b, dict) and b.get('type') == 'tool_result'
                            and b.get('tool_use_id') in codex_calls):
                        c = b.get('content')
                        if has_noid_verdict(c if isinstance(c, str)
                                            else json.dumps(c, ensure_ascii=False)):
                            got = True
            if got:
                ts = o.get('timestamp')
                if ts:
                    try:
                        sess_codex[path].append(
                            datetime.datetime.fromisoformat(ts.replace('Z', '+00:00')))
                    except ValueError:
                        pass

# The second place a verdict lands: the workflow journal
for d in glob.glob(os.path.join(ROOT, '*', '*', 'subagents', 'workflows', 'wf_*')):
    jp = os.path.join(d, 'journal.jsonl')
    if not os.path.exists(jp):
        continue
    stats['journals_scanned'] += 1
    rid = os.path.basename(d)
    for line in open(jp, encoding='utf-8', errors='replace'):
        if 'AUDIT-ID' not in line:
            continue
        try:
            o = json.loads(line)
        except json.JSONDecodeError:
            continue
        if o.get('type') != 'result':
            continue
        r = o.get('result')
        s = r if isinstance(r, str) else json.dumps(r, ensure_ascii=False)
        for fp, rnd in verdict_blocks(s):
            delivered[fp].add(rnd)
            run_delivered[rid].add(rnd)   # fallback for a truncated top-level result with no fingerprint

for v in sess_codex.values():
    v.sort()

# ---- (4) TWO-WAY CALIBRATION OF THE CRITERION ---------------------------------
# GOOD examples: six audits whose raw verdicts a human read line by line and confirmed the reviewer
# delivered in all three rounds. An earlier version classified every one of them as one-sided.
GOOD = ['fp_1wwel2v_yg87nd', 'fp_l55z6f_tvfxrl', 'fp_o78isz_14471uh',
        'fp_1axq4gi_15cidnk', 'fp_6r619x_m16n0t', 'fp_1ajjmov_tmj86j']
# BAD examples: fingerprints for which the corpus holds only a brief and no returned verdict,
# checked by an independent audit.
BAD = ['fp_k9fhtn_1imxbq5', 'fp_g9hoiz_zuchu9']
CAL_FAIL = []
for g in GOOD:
    if not delivered.get(g):
        CAL_FAIL.append(f'GOOD example wrongly rejected: {g}')
for b in BAD:
    if delivered.get(b):
        CAL_FAIL.append(f'BAD example wrongly accepted: {b} -> {sorted(delivered[b])}')

# ---- POPULATION ---------------------------------------------------------------
calls = []
excluded_names = collections.Counter()
for tid, L in launches.items():
    raw = notifs.get(tid)
    obj = parse_result(raw)
    by_name = bool(NAME_RE.search(L['name']))
    by_shape = bool(obj and (PANEL_FIELDS & set(obj)))
    if not (by_name or by_shape):
        excluded_names[L['name']] += 1
        continue
    ts = L.get('ts')
    try:
        when = datetime.datetime.fromisoformat(ts.replace('Z', '+00:00')) if ts else None
    except (ValueError, AttributeError):
        when = None
    if when is None:
        stats['no_timestamp_dropped'] += 1; continue
    calls.append({'tid': tid, 'name': L['name'], 'when': when, 'obj': obj,
                  'fp': (obj or {}).get('task_fingerprint'), 'run': L.get('run'),
                  'file': L['file'], 'narrow': by_shape, 'by_name': by_name,
                  'origin': origin_of(L.get('sp', ''))})


def second_side_delivered(ep):
    """Decide by evidence, not by the status string. Three chains; any one means delivered."""
    # (1) A fingerprint exists: look it up in the delivery index
    if ep['fp'] and not ep['fp'].startswith('<nofp:'):
        return bool(delivered.get(ep['fp']))
    # (2) Top-level result truncated, no fingerprint: consult that workflow's own journal
    for rid in ep['runs']:
        if rid and run_delivered.get(rid):
            return True
    # (3) Historical audits from before the fingerprint/AUDIT-ID scheme existed: did any
    #     reviewer-CLI call in the same session, within WINDOW_H hours after it, return a complete
    #     verdict block?
    #     NOTE: this is the weakest of the three chains. It can FIND delivery; it cannot PROVE
    #     absence. So the "second side did not deliver" figure this script reports is an UPPER
    #     BOUND. The window width affects it, which is why window sensitivity is reported below
    #     and no single value is chosen.
    lo, hi = ep['first'], ep['first'] + datetime.timedelta(hours=WINDOW_H)
    return any(lo <= t <= hi for t in sess_codex.get(ep['file'], ()))


def classify(ep):
    """Terminal state. Errors and infrastructure refusals take precedence, since those never
       reached a review at all; everything else is classified by delivery evidence."""
    obj = ep['obj']
    if obj is None:
        return 'NO_RESULT'
    if str(obj.get('error') or ''):
        return 'INPUT_REJECTED'
    st = str(obj.get('convergence_status') or '')
    if 'identity_mismatch' in st or st.startswith('prior_state') or 'schema_invalid' in st:
        return 'INFRA_REFUSED'
    if obj.get('converged') is True:
        return 'VERDICT_CONVERGED'
    return 'BOTH_DELIVERED_NO_CONV' if second_side_delivered(ep) else 'SECOND_REVIEWER_ABSENT'


ORDER = ['VERDICT_CONVERGED', 'BOTH_DELIVERED_NO_CONV', 'SECOND_REVIEWER_ABSENT',
         'INFRA_REFUSED', 'INPUT_REJECTED', 'NO_RESULT']
LABEL = {'VERDICT_CONVERGED': 'converged', 'BOTH_DELIVERED_NO_CONV': 'both delivered, did not converge',
         'SECOND_REVIEWER_ABSENT': 'second side did not deliver', 'INFRA_REFUSED': 'refused: identity or state check',
         'INPUT_REJECTED': 'rejected on input validation', 'NO_RESULT': 'no parsable result'}


SINCE = (datetime.datetime.fromisoformat(SINCE_RAW).replace(tzinfo=datetime.timezone.utc)
         if SINCE_RAW else None)


def episodes_at(cut, scope='narrow', origins=None):
    sel = [c for c in calls if c['when'] < cut and (SINCE is None or c['when'] >= SINCE)
           and (c['narrow'] or scope == 'wide')
           and (origins is None or c['origin'] in origins)]
    groups = collections.defaultdict(list)
    nofp = 0
    for c in sel:
        if c['fp']:
            groups[c['fp']].append(c)
        else:
            nofp += 1
            groups[f'<nofp:{c["tid"]}>'].append(c)
    def last_origin(vv):
        o = [x['origin'] for x in vv]
        return '[!] packaging smoke-harness' if '[!] packaging smoke-harness' in o else o[-1]

    eps = []
    for k, v in groups.items():
        v.sort(key=lambda x: x['when'])
        last = v[-1]
        ep = {'fp': k, 'n_calls': len(v), 'origin': last_origin(v),
              'mode': 'driver' if any('dual-audit-run' in x['name'] for x in v) else 'hand-carried',
              'obj': last['obj'], 'file': last['file'],
              'runs': [x.get('run') for x in v],
              'names': [x['name'] for x in v], 'first': v[0]['when'], 'last': last['when']}
        ep['state'] = classify(ep)
        ep['rounds'] = sorted(delivered.get(k, ())) if not k.startswith('<nofp:') else []
        eps.append(ep)
    return eps, nofp


# ---- OUTPUT -------------------------------------------------------------------
print('=' * 82)
print('(4) TWO-WAY CALIBRATION OF THE CRITERION -- run first; if it fails, no number below counts')
print('=' * 82)
print(f'  {len(GOOD)} good examples (delivery confirmed by reading the raw record); {len(BAD)} bad (brief only)')
for g in GOOD:
    print(f'    good {g:22s} delivered rounds={sorted(delivered.get(g, ())) or "NONE <- FALSE REJECTION"}')
for b in BAD:
    print(f'    bad  {b:22s} {"still rejected OK" if not delivered.get(b) else f"WRONGLY ACCEPTED {sorted(delivered[b])}"}')
print(f'\n  Calibration: {"PASS (bad rejected AND good not falsely rejected)" if not CAL_FAIL else "FAIL"}')
for _m in CAL_FAIL:
    print(f'    {_m}')
if CAL_FAIL:
    # FAIL-CLOSED. Until 2026-08-25 this branch only printed, and every measurement below was   # sanitize-scan:allow (the date the gate got teeth)
    # emitted anyway with exit status 0 -- a gate that announced a failure and then waved the
    # numbers through. An independent audit of the paper that cites this script found it: the
    # paper claimed the script "refuses to print if either fails", and it did not.
    print('\n  REFUSING TO PRINT ANY MEASUREMENT: the criterion is not calibrated, so no number'
          '\n  below would mean anything. Fix the criterion or the calibration set, then re-run.')
    raise SystemExit(2)

print()
print('=' * 82)
print('(1) POPULATION: a mechanically over-inclusive rule, not a whitelist')
print('=' * 82)
for k, v in sorted(stats.items()):
    print(f'  {k:28s} {v}')
print(f'  {"window --since":34s} {SINCE_RAW or "(none: from the beginning)"}')
print(f'  {"window --cut (freeze)":34s} {MAIN_CUT}')
print(f'  {"workflow launches":34s} {len(launches)}')
print(f'  {"calls, WIDE scope":34s} {len(calls)}')
print(f'  {"calls, NARROW (panel-shaped return)":34s} {sum(1 for c in calls if c["narrow"])}')
print(f'  {"fingerprints with delivery evidence":34s} {len(delivered)}')

print()
print('=' * 82)
print('(2) FREEZE-DATE SENSITIVITY: every boundary reported, none chosen')
print('=' * 82)
hdr = (f'  {"freeze":<12}{"audits":>8}{"conv":>6}{"both, no conv":>16}'
       f'{"2nd absent":>12}{"both delivered":>16}{"share (Wilson 95%)":>24}')
for scope in ('narrow', 'wide'):
    print(f'\n  -- {scope.upper()} scope --')
    print(hdr)
    for cs in CUTS:
        cut = datetime.datetime.fromisoformat(cs).replace(tzinfo=datetime.timezone.utc)
        eps, _ = episodes_at(cut, scope)
        c = collections.Counter(e['state'] for e in eps)
        both = c['VERDICT_CONVERGED'] + c['BOTH_DELIVERED_NO_CONV']
        lo, hi = wilson(both, len(eps)) if eps else (0, 0)
        print(f'  {cs:<12}{len(eps):>6}{c["VERDICT_CONVERGED"]:>6}{c["BOTH_DELIVERED_NO_CONV"]:>16}'
              f'{c["SECOND_REVIEWER_ABSENT"]:>14}{both:>12}'
              f'{f"{100*both/len(eps):.1f}%  [{lo:.1f}, {hi:.1f}]" if eps else "-":>24}')

MAIN = datetime.datetime.fromisoformat(MAIN_CUT).replace(tzinfo=datetime.timezone.utc)
# (7) The main scope excludes the released package's smoke-harness: those failures are induced by
#     the test, not a property of the panel. The harness is disclosed separately in section (7)
#     and never folded in.
MAIN_ORIGINS = {'production', 'inline snapshot', 'scriptPath not recorded', 'other'}
eps, nofp = episodes_at(MAIN, 'narrow', MAIN_ORIGINS)
print(f'\n  (main scope freezes at {MAIN_CUT}; {nofp} calls there carry no fingerprint and each count as one audit)')

print()
print('=' * 82)
print(f'MAIN SCOPE, terminal states (one audit = calls grouped by fingerprint; freeze {MAIN_CUT}; smoke-harness excluded)')
print('=' * 82)
for mode in ('hand-carried', 'driver'):
    a = [e for e in eps if e['mode'] == mode]
    if not a:
        continue
    print(f'\n[{mode}] n = {len(a)} audits   (calls per audit: '
          f'{dict(sorted(collections.Counter(e["n_calls"] for e in a).items()))}）')
    c = collections.Counter(e['state'] for e in a)
    for st in ORDER:
        if c[st]:
            print(f'  {LABEL[st]:26s} {c[st]:4d}   {100.0*c[st]/len(a):5.1f}%')
    both = c['VERDICT_CONVERGED'] + c['BOTH_DELIVERED_NO_CONV']
    lo, hi = wilson(both, len(a))
    print(f'  {"-- both sides delivered":34s} {both:4d}   {100.0*both/len(a):5.1f}%  [Wilson {lo:.1f}, {hi:.1f}]')
    if both:
        lo2, hi2 = wilson(c['VERDICT_CONVERGED'], both)
        print(f'  {"-- of those, converged":34s} {c["VERDICT_CONVERGED"]:4d}   '
              f'{100.0*c["VERDICT_CONVERGED"]/both:5.1f}% (of both-delivered)  [Wilson {lo2:.1f}, {hi2:.1f}]')

allc = collections.Counter(e['state'] for e in eps)
print(f'\n[ALL] n = {len(eps)} audits')
for st in ORDER:
    if allc[st]:
        print(f'  {LABEL[st]:26s} {allc[st]:4d}   {100.0*allc[st]/len(eps):5.1f}%')

print()
print('=' * 82)
print('(6) WINDOW SENSITIVITY: same-session matching window for pre-identifier audits (no value chosen)')
print('=' * 82)
print('  NOTE: the criterion can FIND delivery but cannot PROVE absence -> "2nd absent" is an upper bound')
print(f'  {"window":<10}{"audits":>8}{"2nd absent":>14}{"of which hand-carried":>24}{"of which driver":>18}')
_w0 = WINDOW_H
for _h in (1, 2, 6, 24, 72):
    globals()['WINDOW_H'] = _h
    _e, _ = episodes_at(MAIN, 'narrow', MAIN_ORIGINS)
    _a = [x for x in _e if x['state'] == 'SECOND_REVIEWER_ABSENT']
    print(f'  {str(_h)+"h":<8}{len(_e):>8}{len(_a):>14}'
          f'{sum(1 for x in _a if x["mode"]=="hand-carried"):>16}'
          f'{sum(1 for x in _a if x["mode"]=="driver"):>14}')
globals()['WINDOW_H'] = _w0

print()
print('=' * 82)
print('(7) ORIGIN SPLIT: the panel also runs inside the released package smoke-harness')
print('=' * 82)
print('  The fourth time the population was found unclean. The first three were unit, whitelist and status')
print('  semantics; this one is ORIGIN: a harness the authors run to test the released package leaves records')
print('  identical in shape to production, whose failures are deliberately induced. All splits reported, none chosen.')
_by = collections.Counter(c['origin'] for c in calls)
print(f'\n  {"origin":<32}{"calls":>8}')
for k, v in _by.most_common():
    print(f'  {k:<20}{v:>8}')

print(f'\n  {"population":<32}{"audits":>8}{"conv":>6}{"both, no conv":>16}{"2nd absent":>12}{"infra refused":>15}{"input rej":>11}')
for _label, _org in (('all origins', None),
                     ('production only', {'production'}),
                     ('production + inline snapshot', {'production', 'inline snapshot', 'scriptPath not recorded'}),
                     ('[!] smoke-harness only', {'[!] packaging smoke-harness'})):
    _e, _ = episodes_at(MAIN, 'narrow', _org)
    _c = collections.Counter(x['state'] for x in _e)
    print(f'  {_label:<20}{len(_e):>6}{_c["VERDICT_CONVERGED"]:>6}{_c["BOTH_DELIVERED_NO_CONV"]:>16}'
          f'{_c["SECOND_REVIEWER_ABSENT"]:>14}{_c["INFRA_REFUSED"]:>14}{_c["INPUT_REJECTED"]:>10}')
print('\n  -> The paper table uses production + inline snapshot: the smoke-harness is not an audit of real work.')
print('     The smoke-harness row is disclosed separately and never folded in.')

print()
print('=' * 82)
print('(3) THE SIX AUDITS v5 CALLED ONE-SIDED -- which rounds actually delivered')
print('=' * 82)
for g in GOOD:
    hit = [e for e in eps if e['fp'] == g]
    when = f'{hit[0]["first"]:%Y-%m-%d %H:%M}' if hit else '(outside main scope)'
    print(f'  {when:18s} {g:22s} delivered rounds={sorted(delivered.get(g, ())) or "none"}'
          f'   state={LABEL.get(hit[0]["state"], "-") if hit else "-"}')

print()
print('=' * 82)
print('AUDITS WHERE THE SECOND SIDE DID NOT DELIVER (itemised for human review)')
print('=' * 82)
for e in sorted((e for e in eps if e['state'] == 'SECOND_REVIEWER_ABSENT'), key=lambda x: x['first']):
    print(f'  {e["first"]:%Y-%m-%d %H:%M}  {e["mode"]:5s} {e["fp"][:28]:30s} {"/".join(e["names"])[:40]}')

print()
print('=' * 82)
print('workflowNames EXCLUDED by the population rule (check none was excluded wrongly)')
print('=' * 82)
for n, c in excluded_names.most_common(12):
    print(f'  {c:4d}  {n or "<unnamed>"}')
