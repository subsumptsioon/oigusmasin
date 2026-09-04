#!/usr/bin/env python3
"""
Narkootiliste ainete nimekirja kraapija
Kasutamine: python3 scrape.py [--pdf fail.pdf] [--url URL] [--out data.json]
Soltuvused: pip install pdfplumber
"""

import argparse
import io
import json
import re
import sys
import urllib.request
from pathlib import Path

try:
    import pdfplumber
except ImportError:
    sys.exit("Viga: pdfplumber pole paigaldatud. Käivita: pip install pdfplumber")

# ── URL-id ────────────────────────────────────────────────────────────────────
BASE_URL = "https://www.riigiteataja.ee"
BASE_API = "https://www.riigiteataja.ee/public-api/api/v1"

# Stabiilne grupi-ID -- SAMA kõigi redaktsioonide kohta (ANALYSIS #3).
# Uue redaktsiooni ilmumisel annab riigiteataja.ee aktile UUE ID, aga grupi-ID
# ei muutu. Selle alusel lahendatakse IGA käivituse juures hetkel kehtiv
# redaktsioon (_resolve_current_blob_url), nii et hardcoded URL-i aegumine kaob.
GRUPP_ID = "158713"

# Laaditakse dünaamiliselt (_resolve_current_blob_url) automaatrežiimis.
ACT_URL = None

LIST_TITLES = {1: "I nimekiri", 2: "II nimekiri", 3: "III nimekiri",
               4: "IV nimekiri", 5: "V nimekiri", 6: "VI nimekiri"}
LIST_DESCRIPTIONS = {
    1: "Koige rangemalt piiritletud ained, meditsiiniline kasutus puudub",
    2: "Opioidid ja korge riskiga narkootikumid",
    3: "Kontrollitud ained piiratud meditsiinilise kasutusega",
    4: "Psyhhotroopsed ained meditsiinilise kasutusega",
    5: "Lahteained ja muud kontrollitud ained",
    6: "Kontrollitud ainegruhmad (mitte yksikained)",
}

# ── PDF laadimine ─────────────────────────────────────────────────────────────

def _fetch_text(url, timeout=1000):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")


_CURRENT_BLOB_KEY = [None]


def _resolve_current_blob_url():
    """Tagastab hetkel kehtiva redaktsiooni blob-xml URL-i (salvestab vahemällu).

    Stabiilne grupi-ID (GRUPP_ID) ei muutu; ``/redaktsioonid`` vastus sisaldab
    ``kehtivRedaktsioon`` -- hetkel jõus oleva redaktsiooni ID. Selle kaudu ehitatakse
    uus ``.../akt/{kehtiv}/blob-xml`` URL, vältides hardcoded redaktsiooni aegumist.
    """
    if _CURRENT_BLOB_KEY[0]:
        return _CURRENT_BLOB_KEY[0]
    url = f"{BASE_API}/akt/{GRUPP_ID}/redaktsioonid"
    print("Otsin kehtivat redaktsiooni: " + url)
    try:
        data = json.loads(_fetch_text(url))
    except Exception as e:
        raise RuntimeError("Kehtiva redaktsiooni leidmine ebaõnnestus: " + str(e))
    kehtiv = data.get("kehtivRedaktsioon")
    if not kehtiv:
        raise RuntimeError("kehtivRedaktsioon puudub vastuses: " + url)
    print("  -> kehtiv redaktsioon: " + str(kehtiv))
    blob_url = f"{BASE_API}/akt/{kehtiv}/blob-xml"
    _CURRENT_BLOB_KEY[0] = blob_url
    return blob_url


def find_lisa1_url():
    """
    Leiab Lisa 1 PDF URL-i Riigi Teataja akti XML-ist.
    Otsib <tavatekst> elementi tekstiga "Lisa 1" ja seostatud <fail> elementi.
    Hetkel kehtiv redaktsioon lahendatakse automaatselt stabiilse grupi-ID kaudu.
    """
    global ACT_URL
    from xml.etree import ElementTree as ET
    from urllib.parse import urljoin

    ACT_URL = _resolve_current_blob_url()
    print("Otsin Lisa 1 URL-i: " + ACT_URL)
    try:
        xml_text = _fetch_text(ACT_URL)
    except Exception as e:
        raise RuntimeError("Akti lehe laadimine ebaõnnestus: " + str(e))

    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        raise RuntimeError(f"XML parsimine ebaõnnestus: {e}")

    # Otsib <tavatekst> elementi tekstiga "Lisa 1"
    # Namespace võib olla nimekirjas, seega kasutame wildcard
    namespaces = {
        '': 'default',  # Võib olla, et namespace on defineeritud
    }

    found_url = None

    # Otsi kõik tavatekst elemendid
    for tavatekst in root.iter():
        if tavatekst.tag.endswith('tavatekst') or 'tavatekst' in tavatekst.tag:
            if tavatekst.text and "Lisa 1" in tavatekst.text:
                # Leiti "Lisa 1", nüüd leia vanem sisuTekst ja sealt fail element
                parent = root
                # Otsime fail elementi samas sisuTekst kontekstis
                # XML struktuuri järgi: lisaViide > lisaViit > sisuTekst > [fail, tavatekst]

                # Leia kõik fail elemendid
                for fail in root.iter():
                    if fail.tag.endswith('fail') or 'fail' in fail.tag:
                        fail_nimi = fail.get('failNimi')
                        if fail_nimi and 'lisa' in fail_nimi.lower():
                            # Konstrueeri URL
                            # Baasiks on akti number ja path
                            url = f"/aktilisa/1110/8202/6010/{fail_nimi}"
                            found_url = urljoin(BASE_URL, url)
                            break
                if found_url:
                    break

    if not found_url:
        raise RuntimeError(
            "Lisa 1 linki ei leitud lehelt " + ACT_URL + "\n"
            "Vaata GitHub Actions logi täpsema info jaoks."
        )

    print("  Leitud Lisa 1 URL: " + found_url)
    return found_url, xml_text

def find_effective_date(xml_text):
    """
    Leiab sõnastuse jõustumise kuupäeva akti XML-ist.
    Otsib <kehtivuseAlgus> elemendi.
    Tagastab kuupäeva stringina (nt "23.02.2026") voi None.
    """
    from xml.etree import ElementTree as ET

    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return None

    # Otsi <kehtivuseAlgus> elementi
    for elem in root.iter():
        if elem.tag.endswith('kehtivuseAlgus') or 'kehtivuseAlgus' in elem.tag:
            if elem.text:
                # Konverteeri ISO 8601 format (2026-02-23) tavaliseks formaadiks (23.02.2026)
                date_str = elem.text.strip()
                try:
                    from datetime import datetime
                    date_obj = datetime.strptime(date_str, "%Y-%m-%d")
                    return date_obj.strftime("%d.%m.%Y")
                except (ValueError, ImportError):
                    return date_str
    return None


def load_pdf_bytes(url=None, local_path=None):
    """Laadib PDF-i. Tagastab (tegelik_url, pdf_bytes)."""
    if local_path:
        print("Loen kohalikku faili: " + local_path)
        return local_path, Path(local_path).read_bytes(), None
    effective_date = None
    if url is None:
        url, act_xml = find_lisa1_url()
        effective_date = find_effective_date(act_xml)
        if effective_date:
            print("  Sõnastuse jõustumise kp: " + effective_date)
        else:
            raise RuntimeError(
                "Sõnastuse jõustumise kuupäeva ei leitud lehelt " + ACT_URL + "\n"
                "Kontrolli, kas lehe struktuur on muutunud."
            )
    print("Laadin alla: " + url)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    print("Allalaaditud: " + str(len(data)) + " baiti")
    return url, data, effective_date

# ── PDF parsimine ─────────────────────────────────────────────────────────────

LIST_HEADERS = {
    "I NIMEKIRI": 1, "II NIMEKIRI": 2, "III NIMEKIRI": 3,
    "IV NIMEKIRI": 4, "V NIMEKIRI": 5, "VI NIMEKIRI": 6,
}


def _detect_list_header(text):
    cleaned = re.sub(r"\s+", " ", text.strip().upper())
    for header, num in sorted(LIST_HEADERS.items(), key=lambda x: -len(x[0])):
        if cleaned == header:
            return num
    return None


def _clean_cell(text):
    if text is None:
        return ""
    # Pattern 1: hyphen used as soft line-break — drop \n, keep hyphen
    text = re.sub(r'-\n', '-', str(text))
    # Pattern 2: all other line breaks — replace with a single space
    text = re.sub(r'\n', ' ', text)
    # Collapse any remaining multiple spaces
    return re.sub(r' {2,}', ' ', text).strip()


def _process_row(row, current_list, result):
    combined = " ".join(_clean_cell(c) for c in row if c)

    detected = _detect_list_header(combined)
    if detected:
        return detected

    if current_list is None:
        return None

    skip_patterns = [
        r"^eestikeelne", r"^ingliskeelne", r"^nimetus", r"^aineryhma",
        r"narkootiliste.*ainete", r"^[ivx]+\s+nimekiri\s*$", r"^\d+\s*/\s*\d+$",
    ]
    if any(re.search(p, combined.lower()) for p in skip_patterns):
        return current_list

    cells = [_clean_cell(c) for c in row]
    padded = cells + ["", ""]
    et_cell, en_cell = padded[0], padded[1]

    if et_cell == "" and en_cell != "":
        if result[current_list]:
            result[current_list][-1][1] = (result[current_list][-1][1] + " " + en_cell).strip()
        else:
            print(f"  HOIATUS: ingliskeelne jätk ilma eelneva kirjeta (nimekiri {current_list}): {en_cell!r}")
        return current_list
    if en_cell == "" and et_cell != "":
        if result[current_list]:
            result[current_list][-1][0] = (result[current_list][-1][0] + " " + et_cell).strip()
        else:
            print(f"  HOIATUS: eestikeelne jätk ilma eelneva kirjeta (nimekiri {current_list}): {et_cell!r}")
        return current_list

    if len(et_cell) > 2 and len(en_cell) > 2:
        result[current_list].append([et_cell, en_cell])
    elif len(et_cell) > 2:
        result[current_list].append([et_cell, ""])

    return current_list


def extract_rows_from_pdf(pdf_bytes):
    result = {i: [] for i in range(1, 7)}
    current_list = None

    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        print("Lehekylgi: " + str(len(pdf.pages)))
        for page in pdf.pages:
            events = []

            lines_by_top = {}
            for w in page.extract_words():
                top = round(w["top"])
                lines_by_top.setdefault(top, []).append(w["text"])
            for top, tokens in lines_by_top.items():
                det = _detect_list_header(" ".join(tokens))
                if det is not None:
                    events.append((top, "header", det))

            for tbl in page.find_tables():
                tbl_top = tbl.bbox[1]
                for row_idx, row in enumerate(tbl.extract()):
                    if row:
                        events.append((tbl_top + row_idx, "row", row))

            events.sort(key=lambda e: e[0])

            for _, kind, payload in events:
                if kind == "header":
                    current_list = payload
                elif kind == "row" and any(payload):
                    current_list = _process_row(payload, current_list, result)

    return result

# ── Puhastamine ───────────────────────────────────────────────────────────────

# Known PDF parsing errors where both columns contain the Estonian name.
# Key: et name (lowercase). Value: correct English name.
_EN_CORRECTIONS = {
    "dilämmastikoksiid (n2o)": "Nitrous oxide (N2O)",
}

def clean_results(result):
    cleaned = {}
    for list_num, rows in result.items():
        seen = set()
        unique = []
        for row in rows:
            key = row[0].lower().strip()
            if key and key not in seen:
                seen.add(key)
                # Fix rows where en == et (PDF column bleed-through)
                if row[1].lower().strip() == key and key in _EN_CORRECTIONS:
                    print(f"  Parandan ingliskeelset nimetust: {row[0]!r}")
                    row = [row[0], _EN_CORRECTIONS[key]]
                unique.append(row)
        unique.sort(key=lambda r: r[0].lower())
        cleaned[list_num] = unique
    return cleaned

# ── JSON valjund ──────────────────────────────────────────────────────────────

def build_json(result, pdf_url, effective_date=None):
    return {
        "meta": {
            "source": pdf_url,
            "act": ACT_URL if ACT_URL else f"{BASE_API}/akt/{GRUPP_ID}",
            "effective_date": effective_date,
            "generated": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        },
        "lists": [
            {
                "id": num,
                "title": LIST_TITLES[num],
                "description": LIST_DESCRIPTIONS[num],
                "isGroups": num == 6,
                "substances": [{"et": r[0], "en": r[1]} for r in result.get(num, [])],
            }
            for num in range(1, 7)
        ],
    }


def _strip_generated(data):
    """Tagastab andmete koopia ilma muutuva ``meta.generated`` väljata.

    ``meta.generated`` kirjutatakse igal käivitamisel ajatempliga, mistõttu see
    muutub alati. Võrdluses ignoreerime seda, et faili ei kirjutataks/committitaks
    üle, kui nimekirja sisu ise pole muutunud.
    """
    if isinstance(data, dict):
        meta = data.get("meta")
        if isinstance(meta, dict):
            meta = {k: v for k, v in meta.items() if k != "generated"}
        return dict(data, meta=meta)
    return data

# ── Peaprogramm ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", help="PDF URL (vaikimisi: automaatne leidmine)")
    parser.add_argument("--pdf", help="Kohaliku PDF faili tee")
    parser.add_argument("--out", default="data.json")
    args = parser.parse_args()

    try:
        actual_url, pdf_bytes, effective_date = load_pdf_bytes(url=args.url, local_path=args.pdf)
    except Exception as e:
        sys.exit("Viga PDF laadimisel: " + str(e))

    print("Parsin PDF-i...")
    raw = extract_rows_from_pdf(pdf_bytes)
    result = clean_results(raw)

    total = sum(len(v) for v in result.values())
    for num in range(1, 7):
        unit = "ryhma" if num == 6 else "ainet"
        print("  Nimekiri " + str(num) + ": " + str(len(result[num])) + " " + unit)
    print("  Kokku: " + str(total))

    empty = [n for n in range(1, 7) if not result[n]]
    if empty:
        msg = "VIGA: Tyhjad nimekirjad: " + str(empty) + "\nPDF struktuur on ilmselt muutunud."
        print("\n" + msg, file=sys.stderr)
        print("\n" + msg)
        sys.exit(1)

    output = build_json(result, actual_url, effective_date)
    out_path = Path(args.out)

    # Ära kirjuta faili üle, kui sisu pole tegelikult muutunud.
    # meta.generated (ajatempel) muutub igal käivitamisel ja tekitaks tühje
    # commitsid; ignoreerime seda võrdluses ja jätame faili puutumata.
    if out_path.exists():
        try:
            existing = json.loads(out_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            existing = None
        if existing is not None and _strip_generated(existing) == _strip_generated(output):
            print("No changes; not overwriting " + str(out_path))
            return 0

    tmp_path = out_path.with_suffix(".tmp")
    try:
        tmp_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp_path.replace(out_path)
    except PermissionError:
        alt_path = out_path.with_stem(out_path.stem + "_new")
        tmp_path.rename(alt_path)
        out_path = alt_path
        print("Ei saanud kirjutada '" + args.out + "'. Salvestatud: " + str(alt_path))

    print("\nSalvestatud: " + str(out_path) + " (" + str(out_path.stat().st_size) + " baiti)")


if __name__ == "__main__":
    main()
