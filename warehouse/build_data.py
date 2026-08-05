#!/usr/bin/env python3
"""
Goettl LV — Warehouse Movement Daily — data build (engine v1, locked 2026-08-04).

Routes input .xlsx files by HEADER SIGNATURE (filenames don't matter):
  * Movement  — header contains 'Transaction Type'   (Inventory - Profit Planner; MTD and/or single-day, any mix)
  * Snapshot  — header contains 'Quantity on Hand'   (Aggregate Inventory Stock Report; exactly the 2 newest by Filters date)
  * Jobs      — header contains 'Job #'              (Job Costing w Project info; any mix, deduped by Job #)
Optional: po_items.json in the input dir — Databricks fact_purchase_order_item pull (see WAREHOUSE_SOURCE_MAP.md §6).

Usage:
  python3 build_data.py --input <dir> [--template TEMPLATE.html --out live.html] [--built YYYY-MM-DD]
Emits data.json in CWD and prints a census. Exit 1 on a hard input failure.
All rules per WAREHOUSE_SOURCE_MAP.md — do not re-derive them here.
"""
import argparse, json, glob, os, re, sys, datetime, collections
import openpyxl

TAX = 0.08375                                   # Clark County — embedded in ST movement totals
TAXED = {'Receipt', 'Return', 'Bill', 'Purchase Order'}
CAGES = {'Vegas HVAC Warehouse', 'Vegas Plumbing Warehouse'}   # consumable rule: purchases = consumed on receipt
JH = 'GOETTL WAREHOUSE JOB HOLDING'
ACCT_WH = [('Vegas HVAC Warehouse', 'HVAC Warehouse (consumables cage)'),
           ('Vegas Safety Stock', 'Vegas Safety Stock'),
           ('Open Box Warehouse HVAC', 'Open Box HVAC'),
           ('Warranty Units HVAC', 'Warranty Units HVAC'),
           ('Vegas Plumbing Warehouse', 'Plumbing Warehouse (consumables cage)'),
           ('Plumbing Equipment', 'Plumbing Equipment')]
EQ_WH = ['Vegas Safety Stock', 'Open Box Warehouse HVAC', 'Warranty Units HVAC', 'Plumbing Equipment']

def is_truck(l): return l.startswith('LAS-') or l.startswith('Default Truck')
def fv(x):
    try: return float(x or 0)
    except (TypeError, ValueError): return 0.0
def sv(x):
    x = '' if x is None else str(x)
    return '' if x == 'N/A' else x.strip()

def sheet(path):
    wb = openpyxl.load_workbook(path, read_only=True)
    ws = wb[wb.sheetnames[0]]
    it = ws.iter_rows(values_only=True)
    hdr = [str(c) if c is not None else '' for c in next(it, [])]
    return hdr, it, wb

def filters_date(wb):
    if 'Filters' not in wb.sheetnames: return None
    for r in wb['Filters'].iter_rows(values_only=True):
        cells = [str(c) for c in r if c is not None]
        if len(cells) >= 2 and cells[0].strip().lower() in ('date', 'date range'):
            m = re.search(r'(\d{2})/(\d{2})/(\d{2,4})\s*$', cells[1].strip())
            if m:
                mm, dd, yy = int(m[1]), int(m[2]), int(m[3])
                return datetime.date(yy + 2000 if yy < 100 else yy, mm, dd)
    return None

def eclass(name, desc=''):
    t = (name + ' ' + desc).upper()
    if t.strip() == 'EQUIPMENT': return 'Unspecified'
    if re.search(r'\b905\b.*\bAG\b|AIR GAP FAUCET', t): return 'WP Faucet (AG)'          # excluded from units tie per Stephen 2026-08-04
    if re.search(r'MINI ?SPLIT|DUCTLESS|^ASUM|\bASUM', t): return 'Mini-Split'
    if re.search(r'PACKAGE|PKG ?GAS|PKGGAS|[HM][- ]?PKGD|\bPKG\b|^GPG|\bGPG', t): return 'Package Unit'
    if re.search(r'AIR CONDITIONER|CONDENSER|HEAT PUMP|\bCOND/|\bCOND\b', t): return 'Condenser / HP'
    if re.search(r'^GLXS|^GLXT|^GLZS|^GSX|^GSZ|^ASX|^GZV|\bGLXS|\bGLXT|\bGLZS|\bGSX\w|\bASXC|\bGZV', t): return 'Condenser / HP'
    if re.search(r'FURNACE|GAS FURN|^GR9|^GRVT|^GM9|^GMVC|^ML180|^ML193|^ML296|^SL280|^EL296|\bGR9|\bGRVT|\bGMVC', t): return 'Furnace'
    if re.search(r'\bCOIL\b|^CAPT|^CHPT|^DP\d|^CP\d|^CK\d|\bCAPT|\bCHPT', t): return 'Coil'
    if re.search(r'AIR HANDLER|MULTIPOS|^AMST|^AVPTC|^ARUF|^AHVE|^LGM|\bAMST|\bAVPTC|\bAHVE|\bLGM', t): return 'Air Handler'
    if re.search(r'WATER HEATER|TANKLESS|\b\d+ GAL\b', t): return 'Water Heater'
    if re.search(r'SOFTEN|WATER CONDITIONER|REVERSE OSMOSIS|WATER MAKER|REFINER|SUPREME|CERTIFLOW|CARTRIDGE TANK|HALO|\bRO\b|5 STAR', t): return 'Water Purity'
    return 'Other Equipment'

# ---------- BILL OF MATERIALS (v4) ----------
# Maps a sold invoice TASK name to the component units it must consume. Confirmed by Stephen:
#   Split Gas   = condenser + coil + furnace (3)   Split Heat Pump = HP condenser + air handler (2)
#   Package gas / package HP = 1 package unit      Water heater (tank OR tankless) = 1, simple 1:1
#   Water purity: standalone softener/refiner = 1; refiner + softener = 2 ("most are 2 items")
# '1 Star IAQ Package' is deliberately NOT a Package Unit (IAQ package, would inflate by 31/90d).
BOM_SKIP = re.compile(r'REBUILD|FAN MOTOR|CONTROL BOARD|COMPRESSOR|DE-ICE|EASY START|SOFT START|ANODE'
                      r'|FLUSH|TEST & LIGHT|DRAIN VALVE|SMART SADIE|ZONE SYSTEM|REPIPE|DIAGNOSTIC'
                      r'|REMOVE |CLIENT SUPPLIED|WARR|CREDIT|DISCOUNT|MEMBERSH|REBATE|FINANC|LABOR'
                      r'|CLEAN|SEAL|DUCT|MAINT|TUNE|INSPECT|PERMIT|CRANE|DISPOS|CARTRIDGE'
                      r'|FILTER AND MEMBRANE|ELECTRICAL DISCONNECT|NIPPLE|HEX |\bIAQ\b|BIOCIDE|AEROSEAL')

def bom(name):
    t = (name or '').upper()
    if not t or BOM_SKIP.search(t): return None
    if re.search(r'SPLIT GAS', t):                                   return {'Condenser / HP': 1, 'Coil': 1, 'Furnace': 1}
    if re.search(r'SPLIT HEAT ?PUMP', t):                            return {'Condenser / HP': 1, 'Air Handler': 1}
    if re.search(r'PACKAGE (GAS|HEAT ?PUMP)', t):                    return {'Package Unit': 1}
    if re.search(r'(AC|HP) CONDENSER', t):                           return {'Condenser / HP': 1}
    if re.search(r'\bFURNACE\b', t):                                 return {'Furnace': 1}
    if re.search(r'CASED COIL|PLENUM COIL', t):                      return {'Coil': 1}
    if re.search(r'AIR HANDLER', t):                                 return {'Air Handler': 1}
    if re.search(r'WATER HEATER|TANKLESS SYSTEM SWAP', t):           return {'Water Heater': 1}
    if re.search(r'REFINER AND WATER SOFTENER|REFINER, WATER SOFTENER', t): return {'Water Purity': 2}
    if re.search(r'SOFTENING SYSTEM|\bREFINER\b|SUPREME|REVERSE OSMOSIS', t): return {'Water Purity': 1}
    return None

def install_class(jt):
    if re.match(r'^H-Install (Split|Package)', jt): return 'hvac_full'
    if jt == 'H-Install Partial': return 'hvac_partial'
    if jt == 'P-Install Water Purity': return 'wp'
    if jt == 'P-Install Water Heater': return 'wh'
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True)
    ap.add_argument('--template'); ap.add_argument('--out')
    ap.add_argument('--built', default=None)
    ap.add_argument('--history', default=None, help='history.json path — day-keyed accumulation, 92-day retention')
    ap.add_argument('--notes', default=None, help='notes.json — approved explanations exported from the page, baked into DATA.notes')
    a = ap.parse_args()

    # Router (v4): header signature first, Filters-tab report title only to break exact ties.
    # NOTE 2026-08-05: 'Jobs trailing 90 days' and 'Real Discounts' ship IDENTICAL headers AND
    # identical payloads — header signature alone cannot separate them, so invoice-item files are
    # content-deduped below. Units Installed also matches 'Item GL Group Name'+'Item Quantity',
    # so it is claimed FIRST on its unique 'Completion Date' column.
    movement, snaps, jobsfiles, soldfiles, taskfiles = [], [], [], [], []
    for p in sorted(glob.glob(os.path.join(a.input, '*.xlsx'))):
        if os.path.basename(p).startswith('~$'): continue
        try: hdr, _, _ = sheet(p)
        except Exception: continue
        if 'Transaction Type' in hdr: movement.append(p)
        elif 'Quantity on Hand' in hdr: snaps.append(p)
        elif 'Completion Date' in hdr and 'Item GL Group Name' in hdr: soldfiles.append(p)
        elif 'Invoice Number' in hdr and 'Item Type' in hdr: taskfiles.append(p)
        elif 'Item GL Group Name' in hdr and 'Item Quantity' in hdr: soldfiles.append(p)
        elif 'Job #' in hdr: jobsfiles.append(p)
    if not movement and not os.path.exists(a.history or ''): sys.exit('FATAL: no movement export and no history')

    # ---------- movement ledger (dedupe by (type,doc,date,loc); tax-stripped; Bills dropped) ----------
    seen, ledger = set(), []
    jobstat = {}          # v4: job_number -> live ServiceTitan Job Status, straight off the movement export.
                          # 2,407 jobs / 90 days vs 490 in the MTD Job Costing file. This is THE fix for the
                          # false "open — job not completed" labels (job 550193 reads Completed here).
    for p in movement:
        hdr, it, _ = sheet(p)
        ix = {h: i for i, h in enumerate(hdr)}
        g = lambda r, c: sv(r[ix[c]]) if c in ix else ''
        for r in it:
            tt = g(r, 'Transaction Type')
            jn_s, js_s = g(r, 'Job Number'), g(r, 'Job Status')
            if jn_s and js_s: jobstat[jn_s] = js_s      # captured BEFORE the Bill skip — Bills carry status too
            if not tt or tt == 'Bill': continue
            d = r[ix['Date']]
            iso = d.strftime('%Y-%m-%d') if hasattr(d, 'strftime') else sv(d)[:10]
            key = (tt, g(r, 'Transaction Number'), iso, g(r, 'Inventory Location'), g(r, 'Transfer From'), g(r, 'Transfer To'))
            if key in seen: continue
            seen.add(key)
            gross = fv(r[ix['Total']])
            row = {'t': tt, 'd': iso, 'loc': g(r, 'Inventory Location'), 'from': g(r, 'Transfer From'),
                   'to': g(r, 'Transfer To'), 'v': round(gross / (1 + TAX), 2) if tt in TAXED else round(gross, 2),
                   'doc': g(r, 'Transaction Number'), 'vendor': g(r, 'Vendor Name'), 'tech': g(r, 'Technician Name'),
                   'pot': g(r, 'Purchase Order Type'), 'at': g(r, 'Adjustment Type'), 'rt': g(r, 'Return Type'),
                   'job': g(r, 'Job Number'), 'st': g(r, 'Transaction Status')}
            ledger.append({k: v for k, v in row.items() if v or k in ('t', 'd', 'v')})
    days = sorted({r['d'] for r in ledger})

    # ---------- jobs / installs ----------
    jmap = {}
    for p in jobsfiles:
        hdr, it, _ = sheet(p)
        ix = {h: i for i, h in enumerate(hdr)}
        for r in it:
            jn = sv(r[ix['Job #']])
            if not jn: continue
            end = r[ix['End of Working Time']]
            jmap[jn] = {'jt': sv(r[ix['Job Type']]), 'tech': sv(r[ix['Assigned Technicians']]),
                        'end': end.strftime('%Y-%m-%d') if hasattr(end, 'strftime') else ''}
    inst_by_day = collections.defaultdict(lambda: {'hvac_full': 0, 'hvac_partial': 0, 'wp': 0, 'wh': 0})
    for j in jmap.values():
        c = install_class(j['jt'])
        if c and j['end']: inst_by_day[j['end']][c] += 1

    # ---------- invoice items + BILL OF MATERIALS (v4, 'Jobs trailing 90 days' feed) ----------
    # Invoice TASKS are the demand signal: a sold "Split Gas System" means 1 condenser + 1 coil + 1
    # furnace were used, with certainty. Recipes confirmed by Stephen 2026-08-04 / 2026-08-05.
    # Content-dedupe: 'Real Discounts' ships the same payload as 'Jobs trailing 90 days'.
    inv_eq, bom_job, task_rows, seen_inv = [], collections.defaultdict(collections.Counter), [], set()
    qty_viol = []
    for p in taskfiles:
        hdr, it, _ = sheet(p)
        ix = {h: i for i, h in enumerate(hdr)}
        def gi(r, c):
            i = ix.get(c)
            return sv(r[i]) if i is not None and i < len(r) else ''
        for r in it:
            inv = gi(r, 'Invoice Number')
            if not inv: continue
            nm, ity, jn = gi(r, 'Item Name'), gi(r, 'Item Type'), gi(r, 'Job Number')
            q = fv(gi(r, 'Item Quantity')) or 1.0
            k = (inv, nm, gi(r, 'Item Price'), ity, gi(r, 'Item Cost'), gi(r, 'Item Quantity'))
            if k in seen_inv: continue          # identical duplicate feed (Real Discounts)
            seen_inv.add(k)
            d = r[ix['Invoice Date']] if 'Invoice Date' in ix and ix['Invoice Date'] < len(r) else None
            iso = d.strftime('%Y-%m-%d') if hasattr(d, 'strftime') else sv(d)[:10]
            if ity == 'Service':
                b = bom(nm)
                if b:
                    # Guard: Item Quantity on service tasks is not always a whole count — the feed
                    # carries 0.27 / 0.5 / 1.5 on labor lines and NEGATIVE values (e.g. 'Need
                    # Drywaller' at -1.8). A sold system is a whole unit; clamp to a positive integer
                    # so a stray fraction can never inflate or subtract expected component units.
                    # Sign-aware HALF-UP rounding. Python's round() is banker's rounding, so
                    # round(0.5) == 0 and a half-unit task would vanish. Negatives are credit /
                    # reversal lines (a re-invoiced job carries +1 and -1 of the same task) and MUST
                    # subtract so the pair nets to zero — treating -1 as +1 double-counted the system.
                    qn = (1 if q >= 0 else -1) * int(abs(q) + 0.5) if q else 1
                    if qn == 0: qn = 1 if q > 0 else 0
                    if q != qn or q < 0:
                        # Stephen 2026-08-05: a partial quantity is fine on labor, but AC units, water
                        # heaters and water purity systems are ALWAYS whole 1:1 physical equipment.
                        # A fraction on one of those breaks the rule — surface the job, never silently clamp.
                        qty_viol.append({'job': jn, 'task': nm[:70], 'q': q, 'used': qn,
                                         'kind': 'reversal' if q < 0 else 'partial',
                                         'cls': ', '.join(sorted(b)), 'd': iso,
                                         'tech': gi(r, 'Assigned Technicians')[:24],
                                         'jt': gi(r, 'Job Type')})
                    for cls, n in b.items(): bom_job[jn][cls] += n * qn
                    q = qn
                    task_rows.append({'d': iso, 'job': jn, 'task': nm[:70], 'q': q,
                                      'jt': gi(r, 'Job Type'), 'bom': b,
                                      'tech': gi(r, 'Assigned Technicians')[:24]})
            elif ity == 'Equipment':
                c = eclass(nm)
                if c == 'WP Faucet (AG)': continue        # excluded per Stephen
                inv_eq.append({'d': iso, 'job': jn, 'name': nm[:46], 'cls': c, 'q': q,
                               'jt': gi(r, 'Job Type')})
            if jn and gi(r, 'Job Type'):
                jmap.setdefault(jn, {'jt': gi(r, 'Job Type'),
                                     'tech': gi(r, 'Assigned Technicians'), 'end': ''})

    # ---------- sold units (Units Installed report) ----------
    # Day key = Completion Date (fallback Invoice Date). Files may overlap days (trailing-14 window):
    # per-day newest-file-wins, files ranked by (has Job Number column, max data date).
    def load_sold(p):
        hdr, it, _ = sheet(p)
        ix = {h: i for i, h in enumerate(hdr)}
        dcol = 'Completion Date' if 'Completion Date' in ix else 'Invoice Date'
        jcol = next((h for h in hdr if h.strip().lower() in ('job', 'job #', 'job number')), None)
        byd = {}
        for r in it:
            nm = sv(r[ix['Item Name']])
            if not nm: continue
            d = r[ix[dcol]]
            iso = d.strftime('%Y-%m-%d') if hasattr(d, 'strftime') else sv(d)[:10]
            byd.setdefault(iso, []).append({'d': iso, 'name': nm[:46], 'code': sv(r[ix['Item Code']]),
                                            'cls': eclass(nm), 'q': fv(r[ix['Item Quantity']]),
                                            'jt': sv(r[ix['Job Type']]), 'job': sv(r[ix[jcol]]) if jcol else ''})
        return byd, bool(jcol)
    sold_days = {}
    ranked = []
    for p in soldfiles:
        byd, hasjob = load_sold(p)
        ranked.append((hasjob, max(byd) if byd else '', byd))
    for hasjob, mx, byd in sorted(ranked, key=lambda x: (x[0], x[1])):   # best file applied last → wins overlapping days
        sold_days.update(byd)
    sold = [s for d in sorted(sold_days) for s in sold_days[d] if s['cls'] != 'WP Faucet (AG)']   # faucets excluded per Stephen 2026-08-04

    # ---------- snapshots (2 newest by Filters date) ----------
    warnings, month, skus, cls_roll, tie = [], None, [], {}, []
    snap0 = snap1 = None; d0 = d1 = None
    if len(snaps) >= 2:
        dated = sorted(((filters_date(sheet(p)[2]), p) for p in snaps), key=lambda x: (x[0] or datetime.date.min))
        (d0, p0), (d1, p1) = dated[-2], dated[-1]
        if len(dated) > 2: warnings.append(f'{len(dated)} snapshots found — using {d0} and {d1}.')
        def loadsnap(p):
            hdr, it, _ = sheet(p)
            ix = {h: i for i, h in enumerate(hdr)}
            out = {}
            for r in it:
                loc = sv(r[ix['Inventory Location']])
                if not loc: continue
                d = out.setdefault(loc, {})
                c = sv(r[ix['Item Code']])
                itm = d.setdefault(c, {'name': sv(r[ix['Item Name']])[:46], 'desc': sv(r[ix['Item Description']])[:90],
                                       'ty': sv(r[ix['Item Type']]), 'q': 0.0, 'v': 0.0})
                itm['q'] += fv(r[ix['Quantity on Hand']]); itm['v'] += fv(r[ix['Total Item Cost']])
            return out
        snap0, snap1 = loadsnap(p0), loadsnap(p1)
    else:
        warnings.append('Fewer than 2 stock snapshots — Equipment Watch stock math and Month Tie-Out omitted.')

    # ---------- optional Databricks PO items ----------
    eq_po = []
    pj = os.path.join(a.input, 'po_items.json')
    if os.path.exists(pj):
        po = json.load(open(pj))
        ci = {c: i for i, c in enumerate(po['cols'])}
        for r in po['rows']:
            name = r[ci['item_name']] or ''; job = r[ci['job_number']]
            eq_po.append({'d': r[ci['purchase_order_date']], 'name': name[:46], 'cls': eclass(name),
                          'q': fv(r[ci['quantity']]), 'v': round(fv(r[ci['total']]), 2), 'job': str(job or ''),
                          'vendor': (r[ci['primary_vendor_name']] or '')[:30], 'po': str(r[ci['purchase_order_number']] or ''),
                          'dest': 'Direct to job' if job else 'Stock replenishment', 'st': 'stock', 'j': None})
    else:
        warnings.append('po_items.json missing — equipment ledger empty this run.')

    # ---------- month panel + equipment stock math (snapshot window) ----------
    if snap0:
        w0, w1 = (d0 or datetime.date.min).isoformat(), (d1 or datetime.date.max).isoformat()
        inwin = lambda d: w0 < d <= w1
        mv = collections.defaultdict(lambda: collections.defaultdict(float))
        mvn = collections.defaultdict(lambda: collections.defaultdict(int))
        for r in ledger:
            if not inwin(r['d']): continue
            loc = r.get('loc', '')
            if r['t'] == 'Receipt': mv[loc]['rec'] += r['v']; mvn[loc]['nrec'] += 1
            elif r['t'] == 'Return': mv[loc]['ret'] += r['v']; mvn[loc]['nret'] += 1
            elif r['t'] == 'Adjustment': mv[loc]['adj'] += r['v']; mvn[loc]['nadj'] += 1
            elif 'Transfer' in r['t']: mvn[r.get('to', '')]['xin'] += 1; mvn[r.get('from', '')]['xout'] += 1
        whval = lambda sn, loc: round(sum(i['v'] for i in sn.get(loc, {}).values()), 2)
        def top_items(loc, n=6):
            diffs = []
            for c in set(snap0.get(loc, {})) | set(snap1.get(loc, {})):
                i0, i1 = snap0.get(loc, {}).get(c), snap1.get(loc, {}).get(c)
                dv = (i1['v'] if i1 else 0) - (i0['v'] if i0 else 0)
                if abs(dv) < 0.005: continue
                ref = i1 or i0
                diffs.append({'name': ref['name'][:44], 'dq': (i1['q'] if i1 else 0) - (i0['q'] if i0 else 0), 'dv': round(dv, 2)})
            return sorted(diffs, key=lambda x: -abs(x['dv']))[:n]
        month_wh = []
        for loc, label in ACCT_WH:
            o, c = whval(snap0, loc), whval(snap1, loc)
            m, n = mv[loc], mvn[loc]
            valued = round(m['rec'] - m['ret'] + m['adj'], 2)
            month_wh.append({'loc': loc, 'label': label, 'open': o, 'close': c, 'var': round(c - o, 2),
                             'rec': round(m['rec'], 2), 'ret': round(m['ret'], 2), 'adj': round(m['adj'], 2),
                             'nrec': n['nrec'], 'nret': n['nret'], 'nadj': n['nadj'], 'xin': n['xin'], 'xout': n['xout'],
                             'resid': round(c - o - valued, 2), 'cage': loc in CAGES, 'items': top_items(loc)})
        jh = {'open': whval(snap0, JH), 'close': whval(snap1, JH), 'rec': round(mv[JH]['rec'], 2),
              'nrec': mvn[JH]['nrec'], 'adj': round(mv[JH]['adj'], 2), 'items': top_items(JH, 8)}
        odd = [{'loc': l, 'open': whval(snap0, l), 'close': whval(snap1, l), 'var': round(whval(snap1, l) - whval(snap0, l), 2)}
               for l in set(list(snap0) + list(snap1))
               if not is_truck(l) and l not in dict(ACCT_WH) and l != JH and (abs(whval(snap0, l)) > 0.005 or abs(whval(snap1, l)) > 0.005)]
        trucks = {'open': round(sum(whval(snap0, l) for l in snap0 if is_truck(l)), 2),
                  'close': round(sum(whval(snap1, l) for l in snap1 if is_truck(l)), 2),
                  'adj': round(sum(r['v'] for r in ledger if r['t'] == 'Adjustment' and is_truck(r.get('loc', '')) and inwin(r['d'])), 2)}
        month = {'wh': month_wh, 'jh': jh, 'odd': odd, 'trucks': trucks}
        for wh in EQ_WH:
            for c in set(snap0.get(wh, {})) | set(snap1.get(wh, {})):
                i0, i1 = snap0.get(wh, {}).get(c), snap1.get(wh, {}).get(c)
                ref = i1 or i0
                if ref['ty'] != 'Equipment': continue
                q0, v0 = (i0['q'], i0['v']) if i0 else (0, 0); q1, v1 = (i1['q'], i1['v']) if i1 else (0, 0)
                skus.append({'wh': wh, 'name': ref['name'], 'cls': eclass(ref['name'], ref['desc']),
                             'q0': q0, 'q1': q1, 'dq': q1 - q0, 'v0': round(v0, 2), 'v1': round(v1, 2), 'dv': round(v1 - v0, 2)})
        for s in skus:
            r = cls_roll.setdefault(s['cls'], {'q0': 0, 'q1': 0, 'dq': 0, 'dv': 0.0})
            r['q0'] += s['q0']; r['q1'] += s['q1']; r['dq'] += s['dq']; r['dv'] = round(r['dv'] + s['dv'], 2)
        inb, direct = collections.defaultdict(float), collections.defaultdict(float)
        for e in eq_po:
            if not inwin(e['d']): continue
            (inb if e['dest'] == 'Stock replenishment' else direct)[e['cls']] += e['q']
        for cls, r in cls_roll.items():
            so = r['q0'] + inb[cls] - r['q1']
            tie.append({'cls': cls, 'q0': r['q0'], 'in': inb[cls], 'q1': r['q1'], 'stock_out': round(so, 1),
                        'direct': direct[cls], 'total_to_jobs': round(so + direct[cls], 1)})
        inst_tot = collections.Counter()
        for j in jmap.values():
            c = install_class(j['jt'])
            if c and j['end'] and inwin(j['end']): inst_tot[c] += 1
    else:
        inst_tot = collections.Counter()

    installs = [{'d': j['end'], 'job': jn, 'jt': j['jt'], 'cls': install_class(j['jt']), 'tech': j['tech'][:24]}
                for jn, j in jmap.items() if install_class(j['jt']) and j['end']]

    # ---------- history: day-keyed upsert, 92-day retention ----------
    if a.history:
        H = json.load(open(a.history)) if os.path.exists(a.history) else {'ledger': {}, 'sold': {}, 'installs': {}, 'po': {}}
        def upsert(store, rows, datekey='d'):
            byd = {}
            for r in rows: byd.setdefault(r[datekey], []).append(r)
            for d, rs in byd.items(): store[d] = rs           # replace whole day (self-heal)
        upsert(H['ledger'], ledger); upsert(H['sold'], sold)
        upsert(H['installs'], installs); upsert(H['po'], eq_po)
        cutoff = (datetime.date.fromisoformat(max(list(H['ledger']) + ['1970-01-01'])) - datetime.timedelta(days=92)).isoformat()
        for k in ('ledger', 'sold', 'installs', 'po'):
            H[k] = {d: v for d, v in H[k].items() if d >= cutoff}
        json.dump(H, open(a.history, 'w'), default=str)
        ledger = [r for d in sorted(H['ledger']) for r in H['ledger'][d]]
        sold = [r for d in sorted(H['sold']) for r in H['sold'][d]]
        installs = [r for d in sorted(H['installs']) for r in H['installs'][d]]
        eq_po = [r for d in sorted(H['po']) for r in H['po'][d]]
        days = sorted(set(H['ledger']) | set(H['sold']))   # installs excluded — End of Working Time can stray outside the feed window

    # ---------- v4: job completion resolution + ledger buckets + three-tier variance ----------
    # Runs AFTER the history merge so every historical PO row is re-stated with today's knowledge.
    # Completion date priority: Units Installed Completion Date > Job Costing 'End of Working Time'
    # > invoice date on the job's equipment lines. Status priority: movement Job Status (authoritative,
    # live, 90 days) > presence of a completion date.
    sold_end, inv_end = {}, {}
    for s in sold:
        if s.get('job'): sold_end.setdefault(s['job'], s['d'])
    for e in inv_eq:
        if e.get('job') and e.get('d'): inv_end.setdefault(e['job'], e['d'])
    DONE = {'Completed'}
    DEAD = {'Canceled', 'Cancelled'}
    OPEN = {'Scheduled', 'InProgress', 'Hold'}

    def resolve(job):
        """-> (state, end_date_or_None). state in matched|open|canceled|nofeed."""
        if not job: return 'stock', None
        st = jobstat.get(job, '')
        end = sold_end.get(job) or (jmap.get(job, {}) or {}).get('end') or inv_end.get(job)
        if st in DEAD: return 'canceled', end
        if st in DONE: return 'matched', end
        if st in OPEN: return 'open', end
        if end:        return 'matched', end          # completion evidence with no status row
        return 'nofeed', None                          # NEVER call this "open" — that was the bug

    restated = collections.Counter()
    for e in eq_po:
        state, end = resolve(e.get('job', ''))
        j0 = e.get('st')
        e['st'] = state
        e['j'] = None if state in ('stock', 'nofeed') else {
            'end': end or '', 'jt': (jmap.get(e['job'], {}) or {}).get('jt', ''),
            'tech': ((jmap.get(e['job'], {}) or {}).get('tech') or '')[:24]}
        if j0 != state: restated[f'{j0}->{state}'] += 1
    if restated:
        warnings.append('PO status restated (v4 job-status fix): ' + ', '.join(f'{k} {v}' for k, v in restated.most_common()))

    # --- ledger buckets: consumed on job / returned / missing / received -------------------------
    # Stephen 2026-08-05: anything that left for a job — bought for it OR pulled to it, staged or
    # installed — is ONE bucket. Missing = vendor receipt exists, destination does not.
    def bucket(e):
        if e['st'] in ('matched', 'open', 'canceled'): return 'consumed'
        if e['st'] == 'nofeed': return 'missing'
        return 'received'
    for e in eq_po:
        e['bk'] = bucket(e)
        e['flight'] = (e['st'] == 'open')            # left the warehouse, job not closed yet
    ret_rows = [r for r in ledger if r['t'] == 'Return'
                or (r['t'] == 'Adjustment' and r.get('at') in ('ReturnToVendor', 'ReturnToWarehouse'))]
    buckets = {}
    for key in ('consumed', 'returned', 'missing', 'received'):
        # SCOPE HONESTY: consumed / missing / received are UNIT-level (equipment PO line items, so
        # "count by type" is real). Returned can only be transaction-level — the movement export has
        # no Item Name / Item Quantity, so returns are documents-and-dollars grouped by location, and
        # the bucket is tagged scope='txn' so the page never presents a document count as a unit count.
        txn = (key == 'returned')
        src = ret_rows if txn else [e for e in eq_po if e['bk'] == key]
        by = collections.defaultdict(lambda: {'n': 0.0, 'v': 0.0})
        for e in src:
            grp = (e.get('loc') or 'Unknown location') if txn else e.get('cls', 'Other Equipment')
            by[grp]['n'] += 1 if txn else (e.get('q', 1) or 1)
            by[grp]['v'] += abs(e.get('v', 0) or 0) if txn else (e.get('v', 0) or 0)
        buckets[key] = {'cls': {k: {'n': round(v['n'], 1), 'v': round(v['v'], 2)} for k, v in by.items()},
                        'n': round(sum(v['n'] for v in by.values()), 1),
                        'v': round(sum(v['v'] for v in by.values()), 2),
                        'rows': len(src), 'scope': 'txn' if txn else 'unit',
                        'items': ([{'d': r['d'], 'loc': r.get('loc', ''), 'v': abs(r.get('v', 0)),
                                    'doc': r.get('doc', ''), 'vendor': r.get('vendor', '') or r.get('tech', ''),
                                    'rt': r.get('rt', '') or r.get('at', '')} for r in src] if txn else
                                  [{'d': e['d'], 'name': e['name'], 'cls': e['cls'], 'q': e.get('q', 1),
                                    'v': e.get('v', 0), 'job': e.get('job', ''), 'vendor': e.get('vendor', ''),
                                    'po': e.get('po', ''), 'st': e['st'], 'flight': e.get('flight', False),
                                    'end': (e.get('j') or {}).get('end', '')} for e in src])}

    # --- three-tier variance: required (BOM) vs purchased-to-job vs invoiced --------------------
    po_job = collections.defaultdict(collections.Counter)
    for e in eq_po:
        if e.get('job'): po_job[e['job']][e['cls']] += e.get('q', 1) or 1
    inv_job = collections.defaultdict(collections.Counter)
    for e in inv_eq:
        if e.get('job'): inv_job[e['job']][e['cls']] += e.get('q', 1) or 1
    CLS = ['Condenser / HP', 'Coil', 'Furnace', 'Air Handler', 'Package Unit', 'Water Heater', 'Water Purity']
    branch = []
    for c in CLS:
        req = sum(b[c] for b in bom_job.values())
        branch.append({'cls': c, 'req': round(req, 1),
                       'inv': round(sum(b[c] for b in inv_job.values()), 1),
                       'poj': round(sum(b[c] for b in po_job.values()), 1),
                       'pos': round(sum(e.get('q', 1) for e in eq_po if e['cls'] == c and not e.get('job')), 1)})
    jobvar = []
    for job in set(list(bom_job) + list(po_job) + list(inv_job)):
        state, end = resolve(job)
        rows = []
        for c in set(list(bom_job[job]) + list(po_job[job]) + list(inv_job[job])):
            req, pj, iv = bom_job[job][c], po_job[job][c], inv_job[job][c]
            if not (req or pj or iv): continue
            rows.append({'cls': c, 'req': round(req, 1), 'po': round(pj, 1), 'inv': round(iv, 1),
                         'vmove': round(pj - req, 1), 'vinv': round(iv - req, 1)})
        if not rows: continue
        # Flag precedence. 'over' is Stephen's waste case and REQUIRES a known requirement:
        # required 1 condenser, 2 PO'd to the job -> +1. A job with units moved but NO recognised
        # system task (required 0) is NOT a over-pull — that is a task-classification / itemisation
        # problem and gets its own flag, otherwise it floods the red list with false positives.
        moved = sum(r['po'] for r in rows)
        anyreq = any(r['req'] for r in rows)
        flag = ('over'     if any(r['vmove'] > 0 and r['req'] for r in rows)
                else 'canceled' if state == 'canceled' and moved
                else 'notask'   if moved and not anyreq
                else 'short'    if any(r['vinv'] < 0 and r['req'] for r in rows) else 'ok')
        # Window anchor for the variance sections is the job's COMPLETION date — that is when the
        # sale happened and when units must reconcile. Filtering each side by its own date would split
        # pairs at a window edge (a PO dated 7/21 against a job that closed 7/22). Where completion is
        # unknown, fall back to the earliest PO date on the job so the row still lands in a window
        # instead of disappearing from every one of them; endEst marks it as estimated.
        anchor, est = end, False
        if not anchor:
            pds = [e['d'] for e in eq_po if e.get('job') == job and e.get('d')]
            anchor = min(pds) if pds else inv_end.get(job) or sold_end.get(job) or ''
            est = bool(anchor)
        jobvar.append({'job': job, 'st': state, 'end': end or '', 'anchor': anchor or '',
                       'endEst': est, 'flag': flag, 'rows': rows,
                       'jt': (jmap.get(job, {}) or {}).get('jt', ''),
                       'tech': ((jmap.get(job, {}) or {}).get('tech') or '')[:24]})
    _ORD = {'over': 0, 'canceled': 1, 'notask': 2, 'short': 3, 'ok': 4}
    jobvar.sort(key=lambda x: (_ORD.get(x['flag'], 9), x['anchor'] or '', x['job']))

    notes = {}
    if a.notes and os.path.exists(a.notes):
        try: notes = json.load(open(a.notes))
        except Exception: warnings.append('notes.json unreadable — baked notes skipped')
    elif a.notes is None and os.path.exists(os.path.join(a.input, 'notes.json')):
        try: notes = json.load(open(os.path.join(a.input, 'notes.json')))
        except Exception: warnings.append('notes.json unreadable — baked notes skipped')

    data = {'built': a.built or datetime.date.today().isoformat(), 'days': days, 'ledger': ledger,
            'month': month, 'warnings': warnings, 'sold': sold, 'notes': notes,
            'equip': {'skus': sorted(skus, key=lambda x: -abs(x['dv'])), 'cls': cls_roll, 'po': eq_po,
                      'instDay': inst_by_day, 'instTot': dict(inst_tot), 'tie': tie,
                      'installs': sorted(installs, key=lambda x: x['d'])},
            'bk': buckets, 'branch': branch, 'jobvar': jobvar, 'tasks': task_rows, 'qtyViol': qty_viol,
            'invEq': inv_eq, 'jobstat_n': len(jobstat)}
    json.dump(data, open('data.json', 'w'), default=str)
    stc = collections.Counter(e['st'] for e in eq_po)
    print(json.dumps({'ok': True, 'ledger_rows': len(ledger), 'days': f'{days[0]}..{days[-1]}' if days else '—',
                      'movement_files': len(movement), 'snapshots': [str(d0), str(d1)] if snap0 else None,
                      'jobs': len(jmap), 'po_items': len(eq_po), 'sold_rows': len(sold), 'history': bool(a.history),
                      'jobstat_jobs': len(jobstat), 'po_status': dict(stc),
                      'task_rows': len(task_rows), 'inv_eq_rows': len(inv_eq),
                      'bom_jobs': len(bom_job), 'jobvar_rows': len(jobvar),
                      'flags': dict(collections.Counter(j['flag'] for j in jobvar)),
                      'qty_violations': len(qty_viol),
                      'buckets': {k: (v['n'], v['v']) for k, v in buckets.items()},
                      'branch': {b['cls']: (b['req'], b['inv'], b['poj'], b['pos']) for b in branch},
                      'warnings': warnings}, indent=1))

    if a.template and a.out:
        tpl = open(a.template, encoding='utf-8').read()
        assert '/*__DATA__*/null' in tpl, 'splice marker missing in template'
        open(a.out, 'w', encoding='utf-8').write(tpl.replace('/*__DATA__*/null', json.dumps(data, separators=(",", ":"), default=str)))
        print('spliced ->', a.out)

if __name__ == '__main__':
    main()
