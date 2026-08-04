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

    movement, snaps, jobsfiles, soldfiles = [], [], [], []
    for p in sorted(glob.glob(os.path.join(a.input, '*.xlsx'))):
        if os.path.basename(p).startswith('~$'): continue
        try: hdr, _, _ = sheet(p)
        except Exception: continue
        if 'Transaction Type' in hdr: movement.append(p)
        elif 'Quantity on Hand' in hdr: snaps.append(p)
        elif 'Item GL Group Name' in hdr and 'Item Quantity' in hdr: soldfiles.append(p)
        elif 'Job #' in hdr: jobsfiles.append(p)
    if not movement and not os.path.exists(a.history or ''): sys.exit('FATAL: no movement export and no history')

    # ---------- movement ledger (dedupe by (type,doc,date,loc); tax-stripped; Bills dropped) ----------
    seen, ledger = set(), []
    for p in movement:
        hdr, it, _ = sheet(p)
        ix = {h: i for i, h in enumerate(hdr)}
        g = lambda r, c: sv(r[ix[c]]) if c in ix else ''
        for r in it:
            tt = g(r, 'Transaction Type')
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
            st, jinfo = 'stock', None
            if job:
                j = jmap.get(str(job))
                if j and j['end']: st, jinfo = 'matched', {'end': j['end'], 'jt': j['jt'], 'tech': j['tech'][:24]}
                else: st = 'open'
            eq_po.append({'d': r[ci['purchase_order_date']], 'name': name[:46], 'cls': eclass(name),
                          'q': fv(r[ci['quantity']]), 'v': round(fv(r[ci['total']]), 2), 'job': str(job or ''),
                          'vendor': (r[ci['primary_vendor_name']] or '')[:30], 'po': str(r[ci['purchase_order_number']] or ''),
                          'dest': 'Direct to job' if job else 'Stock replenishment', 'st': st, 'j': jinfo})
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
                      'installs': sorted(installs, key=lambda x: x['d'])}}
    json.dump(data, open('data.json', 'w'), default=str)
    print(json.dumps({'ok': True, 'ledger_rows': len(ledger), 'days': f'{days[0]}..{days[-1]}' if days else '—',
                      'movement_files': len(movement), 'snapshots': [str(d0), str(d1)] if snap0 else None,
                      'jobs': len(jmap), 'po_items': len(eq_po), 'sold_rows': len(sold), 'history': bool(a.history), 'warnings': warnings}, indent=1))

    if a.template and a.out:
        tpl = open(a.template, encoding='utf-8').read()
        assert '/*__DATA__*/null' in tpl, 'splice marker missing in template'
        open(a.out, 'w', encoding='utf-8').write(tpl.replace('/*__DATA__*/null', json.dumps(data, separators=(",", ":"), default=str)))
        print('spliced ->', a.out)

if __name__ == '__main__':
    main()
