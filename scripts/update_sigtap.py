#!/usr/bin/env python3
"""Baixa a Tabela Unificada do SIGTAP (DATASUS) e gera arquivos JSON para o GitHub Pages."""

from __future__ import annotations

import argparse
import csv
import ftplib
import io
import json
import os
import re
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timezone
from pathlib import Path

FTP_HOST = "ftp2.datasus.gov.br"
FTP_DIR = "/pub/sistemas/tup/downloads/"
GITHUB_MIRROR_API = "https://api.github.com/repos/RenatoKR/SIGTAP/contents/tabelas"
TSP_PAGE_URL = "https://www.saude.sp.gov.br/ses/perfil/cidadao/homepage/outros-destaques/tabela-sus-paulista"
TSP_BASE_URL = "https://www.saude.sp.gov.br"

COMPLEXIDADE_MAP = {
    "0": "Não se aplica",
    "1": "Atenção Básica",
    "2": "Média Complexidade",
    "3": "Alta Complexidade",
}

SEXO_MAP = {
    "M": "Masculino",
    "F": "Feminino",
    "I": "Indiferente/Ambos",
    "N": "Não se aplica",
}

CPF_DETALHES = {
    "058": ("obrigatorio_cpf", "Obrigatório CPF"),
    "009": ("exige_cpf_cns", "Exige CPF/CNS"),
    "034": ("nao_exige", "Não exige CPF/CNS"),
}

VALIDADE_APAC_DETALHES = {
    "054": "2 competências",
    "033": "3 competências",
    "041": "12 competências",
    "014": "Admite continuidade",
}


def parse_layout(layout_bytes: bytes) -> list[dict[str, int | str]]:
    """Lê um arquivo *_layout.txt do SIGTAP e retorna a lista de colunas."""
    text = layout_bytes.decode("latin1")
    reader = csv.DictReader(io.StringIO(text))
    columns: list[dict[str, int | str]] = []
    for row in reader:
        columns.append(
            {
                "name": row["Coluna"].strip(),
                "start": int(row["Inicio"]) - 1,
                "end": int(row["Fim"]),
                "type": row["Tipo"].strip(),
            }
        )
    return columns


def read_fixed_table(
    zf: zipfile.ZipFile, table_name: str
) -> list[dict[str, str]]:
    """Lê uma tabela de largura fixa usando seu arquivo *_layout.txt."""
    layout_name = table_name.replace(".txt", "_layout.txt")
    columns = parse_layout(zf.read(layout_name))
    raw_lines = zf.read(table_name).decode("latin1").splitlines()
    rows: list[dict[str, str]] = []
    for line in raw_lines:
        if not line.strip():
            continue
        record = {
            col["name"]: line[col["start"] : col["end"]].strip()
            for col in columns
        }
        rows.append(record)
    return rows


def to_reais(raw_value: str) -> float:
    """Converte valor numérico inteiro do SIGTAP (em centavos) para reais."""
    cleaned = raw_value.strip()
    if not cleaned:
        return 0.0
    return round(int(cleaned) / 100.0, 2)


def to_optional_int(raw_value: str, na_value: int = 9999) -> int | None:
    """Converte campo numérico inteiro tratando o sentinela 9999 como None."""
    cleaned = raw_value.strip()
    if not cleaned:
        return None
    val = int(cleaned)
    return None if val == na_value else val


def extract_competencia(filename: str, rows: list[dict[str, str]]) -> str:
    """Extrai a competência AAAAMM do nome do arquivo ou da primeira linha."""
    match = re.search(r"TabelaUnificada_(\d{6})", filename)
    if match:
        return match.group(1)
    if rows and rows[0].get("DT_COMPETENCIA"):
        return rows[0]["DT_COMPETENCIA"]
    return ""


def download_from_ftp(dest_dir: Path) -> Path:
    """Baixa o arquivo TabelaUnificada_*.zip mais recente via FTP oficial do DATASUS."""
    print(f"Conectando ao FTP oficial ({FTP_HOST})...")
    ftp = ftplib.FTP(FTP_HOST, timeout=45)
    try:
        ftp.login()
        ftp.set_pasv(True)
        ftp.cwd(FTP_DIR)
        files = [
            f
            for f in ftp.nlst()
            if f.startswith("TabelaUnificada_") and f.endswith(".zip")
        ]
        if not files:
            raise RuntimeError("Nenhum arquivo TabelaUnificada_*.zip encontrado no FTP.")
        files.sort()
        latest = files[-1]
        dest_path = dest_dir / latest
        print(f"Baixando {latest} via FTP...")
        with dest_path.open("wb") as fh:
            ftp.retrbinary(f"RETR {latest}", fh.write)
        return dest_path
    finally:
        try:
            ftp.quit()
        except Exception:
            pass


def download_from_github_mirror(dest_dir: Path) -> Path:
    """Fallback via espelho público caso o FTP do DATASUS esteja inacessível."""
    print("Tentando fallback via espelho no GitHub...")
    req = urllib.request.Request(
        GITHUB_MIRROR_API,
        headers={"User-Agent": "sigtap-pages-updater"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        items = json.loads(resp.read().decode("utf-8"))

    zips = [
        item
        for item in items
        if item.get("name", "").startswith("TabelaUnificada_")
        and item.get("name", "").endswith(".zip")
        and item.get("download_url")
    ]
    if not zips:
        raise RuntimeError("Nenhum arquivo encontrado no espelho do GitHub.")
    zips.sort(key=lambda x: x["name"])
    latest = zips[-1]
    dest_path = dest_dir / latest["name"]
    print(f"Baixando {latest['name']} via espelho HTTPS...")
    urllib.request.urlretrieve(latest["download_url"], dest_path)
    return dest_path


def resolve_cpf_status(detalhe_codes: list[str]) -> tuple[str, str]:
    """Determina o status prioritário de exigência de CPF/CNS a partir dos detalhes."""
    for code in ("058", "009", "034"):
        if code in detalhe_codes:
            return CPF_DETALHES[code]
    return ("nao_especificado", "Sem regra específica")


def resolve_validade_apac(detalhe_codes: list[str]) -> str | None:
    """Determina a validade da APAC a partir dos códigos de detalhe do SIGTAP."""
    for code in ("054", "033", "041", "014"):
        if code in detalhe_codes:
            return VALIDADE_APAC_DETALHES[code]
    return None


def _col_ref_to_index(ref: str) -> int:
    """Converte referência de célula (ex: 'AB12') para índice de coluna base 0."""
    letters = "".join(ch for ch in ref if ch.isalpha()).upper()
    idx = 0
    for ch in letters:
        idx = idx * 26 + (ord(ch) - ord("A") + 1)
    return max(0, idx - 1)


def read_xlsx_rows(xlsx_path: Path) -> list[list[str]]:
    """Lê todas as linhas da primeira aba de um arquivo .xlsx sem dependências externas."""
    ns_uri = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    ns = {
        "s": ns_uri,
        "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    }
    with zipfile.ZipFile(xlsx_path) as zf:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in zf.namelist():
            sroot = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in sroot.findall("s:si", ns):
                shared.append("".join(t.text or "" for t in si.iter(f"{{{ns_uri}}}t")))

        wb = ET.fromstring(zf.read("xl/workbook.xml"))
        rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
        rel_map = {r.attrib["Id"]: r.attrib["Target"] for r in rels}
        first_sheet = wb.findall(".//s:sheet", ns)[0]
        rid = first_sheet.attrib[
            "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
        ]
        target = "xl/" + rel_map[rid].lstrip("/")
        if target.startswith("xl/xl/"):
            target = target[3:]

        root = ET.fromstring(zf.read(target))
        rows: list[list[str]] = []
        for row_el in root.findall(".//s:sheetData/s:row", ns):
            cells: dict[int, str] = {}
            max_idx = -1
            for c in row_el.findall("s:c", ns):
                col_idx = _col_ref_to_index(c.attrib.get("r", "A1"))
                ctype = c.attrib.get("t")
                v_el = c.find("s:v", ns)
                is_el = c.find("s:is", ns)
                val = ""
                if ctype == "s" and v_el is not None and v_el.text is not None:
                    val = shared[int(v_el.text)]
                elif ctype == "inlineStr" and is_el is not None:
                    val = "".join(t.text or "" for t in is_el.iter(f"{{{ns_uri}}}t"))
                elif v_el is not None and v_el.text is not None:
                    val = v_el.text
                cells[col_idx] = val.strip()
                if col_idx > max_idx:
                    max_idx = col_idx
            if max_idx >= 0:
                rows.append([cells.get(i, "") for i in range(max_idx + 1)])
        return rows


def to_float2(raw: str) -> float:
    """Converte número textual (com ponto ou vírgula) para float arredondado em 2 casas."""
    txt = str(raw or "").strip().replace(",", ".")
    if not txt:
        return 0.0
    try:
        return round(float(txt), 2)
    except ValueError:
        return 0.0


def norm_tsp_code(raw: str) -> str:
    """Normaliza código de procedimento da TSP preenchendo zero à esquerda (10 dígitos)."""
    digits = "".join(ch for ch in str(raw or "") if ch.isdigit())
    return digits.zfill(10) if digits else ""


def infer_tsp_referencia(filenames: list[str]) -> str:
    """Extrai a referência (ex: 'Junho/2026') dos nomes de arquivo da TSP."""
    for name in filenames:
        m = re.search(r"(20\d{2})[_-]+([a-zA-ZçÇ]+)", name)
        if m:
            return f"{m.group(2).capitalize()}/{m.group(1)}"
    return ""


def discover_and_download_tsp(dest_dir: Path) -> dict[str, Path]:
    """Localiza e baixa as planilhas AIH, SIA e OPME da Tabela SUS Paulista."""
    req = urllib.request.Request(TSP_PAGE_URL, headers={"User-Agent": "SIGTAP-Pages-Bot/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        html = resp.read().decode("utf-8", errors="replace")

    links = sorted(set(re.findall(r'href=["\']([^"\']+\.xlsx)["\']', html, flags=re.I)))
    found: dict[str, Path] = {}
    for link in links:
        low = link.lower()
        if "alteracoes" in low or "beneficiarios" in low:
            continue
        kind = None
        for k in ("aih", "sia", "opme"):
            if f"_-_{k}.xlsx" in low or f"_{k}.xlsx" in low or f"-{k}.xlsx" in low:
                kind = k
                break
        if not kind or kind in found:
            continue
        full_url = link if link.startswith("http") else f"{TSP_BASE_URL}{link}"
        dest = dest_dir / Path(link).name
        print(f"Baixando Tabela SUS Paulista ({kind.upper()}): {full_url}")
        dl_req = urllib.request.Request(full_url, headers={"User-Agent": "SIGTAP-Pages-Bot/1.0"})
        with urllib.request.urlopen(dl_req, timeout=60) as dl_resp, open(dest, "wb") as out:
            out.write(dl_resp.read())
        found[kind] = dest
    return found


def load_tsp_data(tsp_files: dict[str, Path] | None) -> tuple[dict[str, dict], str]:
    """Carrega os valores da Tabela SUS Paulista (SIA, AIH, OPME) por código de procedimento."""
    if not tsp_files:
        return {}, ""
    by_proc: dict[str, dict] = {}
    referencia = infer_tsp_referencia([p.name for p in tsp_files.values()])

    for kind in ("sia", "aih", "opme"):
        fpath = tsp_files.get(kind)
        if not fpath or not fpath.exists():
            continue
        rows = read_xlsx_rows(fpath)
        if len(rows) < 2:
            continue
        for row in rows[1:]:
            if not row:
                continue
            co = norm_tsp_code(row[0])
            if not co:
                continue
            entry: dict[str, float] = {
                "ms": to_float2(row[2] if len(row) > 2 else ""),
                "compl": to_float2(row[3] if len(row) > 3 else ""),
                "total": to_float2(row[4] if len(row) > 4 else ""),
            }
            if kind == "aih":
                entry["sh"] = to_float2(row[5] if len(row) > 5 else "")
                entry["sp"] = to_float2(row[6] if len(row) > 6 else "")
            by_proc.setdefault(co, {})[kind] = entry

    return by_proc, referencia


def build_datasets(
    zip_path: Path, out_dir: Path, tsp_files: dict[str, Path] | None = None
) -> dict[str, object]:
    """Processa o arquivo ZIP do SIGTAP e gera os JSONs de saída."""
    out_dir.mkdir(parents=True, exist_ok=True)
    tsp_by_proc, tsp_referencia = load_tsp_data(tsp_files)

    with zipfile.ZipFile(zip_path) as zf:
        proc_rows = read_fixed_table(zf, "tb_procedimento.txt")
        grupo_map = {
            r["CO_GRUPO"]: r["NO_GRUPO"]
            for r in read_fixed_table(zf, "tb_grupo.txt")
        }
        subgrupo_map = {
            (r["CO_GRUPO"], r["CO_SUB_GRUPO"]): r["NO_SUB_GRUPO"]
            for r in read_fixed_table(zf, "tb_sub_grupo.txt")
        }
        forma_map = {
            (r["CO_GRUPO"], r["CO_SUB_GRUPO"], r["CO_FORMA_ORGANIZACAO"]): r[
                "NO_FORMA_ORGANIZACAO"
            ]
            for r in read_fixed_table(zf, "tb_forma_organizacao.txt")
        }
        fin_map = {
            r["CO_FINANCIAMENTO"]: r["NO_FINANCIAMENTO"]
            for r in read_fixed_table(zf, "tb_financiamento.txt")
        }
        detalhe_map = {
            r["CO_DETALHE"]: r["NO_DETALHE"]
            for r in read_fixed_table(zf, "tb_detalhe.txt")
        }
        registro_map = {
            r["CO_REGISTRO"]: r["NO_REGISTRO"]
            for r in read_fixed_table(zf, "tb_registro.txt")
        }
        modalidade_map = {
            r["CO_MODALIDADE"]: r["NO_MODALIDADE"]
            for r in read_fixed_table(zf, "tb_modalidade.txt")
        }

        proc_detalhes: dict[str, list[str]] = {}
        for r in read_fixed_table(zf, "rl_procedimento_detalhe.txt"):
            proc_detalhes.setdefault(r["CO_PROCEDIMENTO"], []).append(
                r["CO_DETALHE"]
            )

        proc_registros: dict[str, list[str]] = {}
        for r in read_fixed_table(zf, "rl_procedimento_registro.txt"):
            reg_name = registro_map.get(r["CO_REGISTRO"], r["CO_REGISTRO"])
            lst = proc_registros.setdefault(r["CO_PROCEDIMENTO"], [])
            if reg_name not in lst:
                lst.append(reg_name)

        proc_modalidades: dict[str, list[str]] = {}
        for r in read_fixed_table(zf, "rl_procedimento_modalidade.txt"):
            mod_name = modalidade_map.get(r["CO_MODALIDADE"], r["CO_MODALIDADE"])
            lst = proc_modalidades.setdefault(r["CO_PROCEDIMENTO"], [])
            if mod_name not in lst:
                lst.append(mod_name)

        descricoes = {
            r["CO_PROCEDIMENTO"]: r["DS_PROCEDIMENTO"]
            for r in read_fixed_table(zf, "tb_descricao.txt")
            if r["DS_PROCEDIMENTO"]
        }

        compatibilidades: dict[str, list[dict[str, object]]] = {}
        for r in read_fixed_table(zf, "rl_procedimento_compativel.txt"):
            co_princ = r["CO_PROCEDIMENTO_PRINCIPAL"]
            qt_raw = r["QT_PERMITIDA"].strip()
            qt_perm = int(qt_raw) if qt_raw else 0
            compatibilidades.setdefault(co_princ, []).append(
                {
                    "codigo": r["CO_PROCEDIMENTO_COMPATIVEL"],
                    "tipo": r["TP_COMPATIBILIDADE"],
                    "reg_p": registro_map.get(
                        r["CO_REGISTRO_PRINCIPAL"], r["CO_REGISTRO_PRINCIPAL"]
                    ),
                    "reg_c": registro_map.get(
                        r["CO_REGISTRO_COMPATIVEL"], r["CO_REGISTRO_COMPATIVEL"]
                    ),
                    "qt": qt_perm,
                }
            )

        ocupacao_map = {
            r["CO_OCUPACAO"]: r["NO_OCUPACAO"]
            for r in read_fixed_table(zf, "tb_ocupacao.txt")
        }
        proc_cbos: dict[str, list[str]] = {}
        used_cbos: dict[str, str] = {}
        for r in read_fixed_table(zf, "rl_procedimento_ocupacao.txt"):
            co_proc = r["CO_PROCEDIMENTO"]
            co_cbo = r["CO_OCUPACAO"]
            proc_cbos.setdefault(co_proc, []).append(co_cbo)
            if co_cbo not in used_cbos:
                used_cbos[co_cbo] = ocupacao_map.get(co_cbo, co_cbo)
        for co_proc, lst in proc_cbos.items():
            proc_cbos[co_proc] = sorted(set(lst))

        servico_map = {
            r["CO_SERVICO"]: r["NO_SERVICO"]
            for r in read_fixed_table(zf, "tb_servico.txt")
        }
        serv_class_map = {
            f"{r['CO_SERVICO']}|{r['CO_CLASSIFICACAO']}": r["NO_CLASSIFICACAO"]
            for r in read_fixed_table(zf, "tb_servico_classificacao.txt")
        }
        habilitacao_map = {
            r["CO_HABILITACAO"]: r["NO_HABILITACAO"]
            for r in read_fixed_table(zf, "tb_habilitacao.txt")
        }
        grupo_hab_map = {
            r["NU_GRUPO_HABILITACAO"]: {
                "nome": r["NO_GRUPO_HABILITACAO"],
                "desc": r["DS_GRUPO_HABILITACAO"],
            }
            for r in read_fixed_table(zf, "tb_grupo_habilitacao.txt")
        }

        proc_servicos: dict[str, list[list[str]]] = {}
        for r in read_fixed_table(zf, "rl_procedimento_servico.txt"):
            co_proc = r["CO_PROCEDIMENTO"]
            pair = [r["CO_SERVICO"], r["CO_CLASSIFICACAO"]]
            lst = proc_servicos.setdefault(co_proc, [])
            if pair not in lst:
                lst.append(pair)

        proc_habilitacoes: dict[str, list[list[str]]] = {}
        for r in read_fixed_table(zf, "rl_procedimento_habilitacao.txt"):
            co_proc = r["CO_PROCEDIMENTO"]
            pair = [r["CO_HABILITACAO"], r["NU_GRUPO_HABILITACAO"]]
            lst = proc_habilitacoes.setdefault(co_proc, [])
            if pair not in lst:
                lst.append(pair)

        requisitos_por_proc: dict[str, dict[str, object]] = {}
        for co_proc in set(proc_servicos) | set(proc_habilitacoes):
            entry: dict[str, object] = {}
            if co_proc in proc_servicos:
                entry["s"] = proc_servicos[co_proc]
            if co_proc in proc_habilitacoes:
                entry["h"] = proc_habilitacoes[co_proc]
            requisitos_por_proc[co_proc] = entry

        cid_map = {
            r["CO_CID"]: r["NO_CID"]
            for r in read_fixed_table(zf, "tb_cid.txt")
        }
        proc_cids: dict[str, list[list[str]]] = {}
        used_cids: dict[str, str] = {}
        for r in read_fixed_table(zf, "rl_procedimento_cid.txt"):
            co_proc = r["CO_PROCEDIMENTO"]
            co_cid = r["CO_CID"]
            st_princ = r["ST_PRINCIPAL"]
            proc_cids.setdefault(co_proc, []).append([co_cid, st_princ])
            if co_cid not in used_cids:
                used_cids[co_cid] = cid_map.get(co_cid, co_cid)
        for co_proc, lst in proc_cids.items():
            lst.sort(key=lambda item: (0 if item[1] == "S" else 1, item[0]))

        versao_txt = ""
        if "versao" in zf.namelist():
            versao_txt = zf.read("versao").decode("latin1").strip()

    competencia = extract_competencia(zip_path.name, proc_rows)
    procedimentos: list[dict[str, object]] = []

    for r in proc_rows:
        co = r["CO_PROCEDIMENTO"]
        co_grupo = co[:2]
        co_sub = co[2:4]
        co_forma = co[4:6]

        det_codes = proc_detalhes.get(co, [])
        cpf_key, cpf_label = resolve_cpf_status(det_codes)
        validade_apac = resolve_validade_apac(det_codes)
        det_labels = [detalhe_map.get(c, c) for c in det_codes]
        proc_compat = compatibilidades.get(co, [])
        qt_obrig = sum(1 for item in proc_compat if item["tipo"] == "5")
        qt_compat = sum(1 for item in proc_compat if item["tipo"] == "1")
        qt_cbos = len(proc_cbos.get(co, []))
        nao_exige_cbo = "021" in det_codes
        qt_servicos = len(proc_servicos.get(co, []))
        qt_habilitacoes = len(proc_habilitacoes.get(co, []))
        qt_cids = len(proc_cids.get(co, []))

        vl_sh = to_reais(r["VL_SH"])
        vl_sa = to_reais(r["VL_SA"])
        vl_sp = to_reais(r["VL_SP"])
        # No SIGTAP, o valor hospitalar total do procedimento costuma ser SH + SP,
        # enquanto SA representa o valor ambulatorial. Mantemos os três separados e o maior/total.
        vl_total_hosp = round(vl_sh + vl_sp, 2)

        proc_obj = {
            "codigo": co,
            "nome": r["NO_PROCEDIMENTO"],
            "grupo_cod": co_grupo,
            "grupo": grupo_map.get(co_grupo, co_grupo),
            "subgrupo_cod": f"{co_grupo}{co_sub}",
            "subgrupo": subgrupo_map.get((co_grupo, co_sub), ""),
            "forma_cod": f"{co_grupo}{co_sub}{co_forma}",
            "forma": forma_map.get((co_grupo, co_sub, co_forma), ""),
            "complexidade_cod": r["TP_COMPLEXIDADE"],
            "complexidade": COMPLEXIDADE_MAP.get(
                r["TP_COMPLEXIDADE"], r["TP_COMPLEXIDADE"]
            ),
            "sexo_cod": r["TP_SEXO"],
            "sexo": SEXO_MAP.get(r["TP_SEXO"], r["TP_SEXO"]),
            "idade_min": to_optional_int(r["VL_IDADE_MINIMA"]),
            "idade_max": to_optional_int(r["VL_IDADE_MAXIMA"]),
            "vl_sh": vl_sh,
            "vl_sa": vl_sa,
            "vl_sp": vl_sp,
            "vl_hosp_total": vl_total_hosp,
            "qt_max": to_optional_int(r["QT_MAXIMA_EXECUCAO"]),
            "qt_dias_perm": to_optional_int(r["QT_DIAS_PERMANENCIA"]),
            "qt_pontos": to_optional_int(r["QT_PONTOS"]),
            "financiamento": fin_map.get(
                r["CO_FINANCIAMENTO"], r["CO_FINANCIAMENTO"]
            ),
            "cpf_status": cpf_key,
            "cpf_label": cpf_label,
            "validade_apac": validade_apac,
            "registros": proc_registros.get(co, []),
            "modalidades": proc_modalidades.get(co, []),
            "detalhes": det_labels,
            "qt_obrig": qt_obrig,
            "qt_compat": qt_compat,
            "qt_cbos": qt_cbos,
            "nao_exige_cbo": nao_exige_cbo,
            "qt_servicos": qt_servicos,
            "qt_habilitacoes": qt_habilitacoes,
            "qt_cids": qt_cids,
        }
        if co in tsp_by_proc:
            proc_obj["tsp"] = tsp_by_proc[co]
        procedimentos.append(proc_obj)

    meta = {
        "competencia": competencia,
        "competencia_formatada": (
            f"{competencia[4:6]}/{competencia[:4]}"
            if len(competencia) == 6
            else competencia
        ),
        "arquivo_origem": zip_path.name,
        "versao": versao_txt,
        "total_procedimentos": len(procedimentos),
        "tsp_referencia": tsp_referencia,
        "total_com_tsp": sum(1 for p in procedimentos if "tsp" in p),
        "atualizado_em": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "grupos": [
            {"codigo": k, "nome": v} for k, v in sorted(grupo_map.items())
        ],
        "subgrupos": [
            {
                "grupo_cod": g,
                "codigo": f"{g}{s}",
                "sub_codigo": s,
                "nome": v,
            }
            for (g, s), v in sorted(subgrupo_map.items())
        ],
        "formas_organizacao": [
            {
                "grupo_cod": g,
                "subgrupo_cod": f"{g}{s}",
                "codigo": f"{g}{s}{f}",
                "forma_codigo": f,
                "nome": v,
            }
            for (g, s, f), v in sorted(forma_map.items())
        ],
        "registros": sorted(registro_map.values()),
    }

    (out_dir / "procedimentos.json").write_text(
        json.dumps(procedimentos, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    (out_dir / "descricoes.json").write_text(
        json.dumps(descricoes, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    (out_dir / "compatibilidades.json").write_text(
        json.dumps(compatibilidades, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    (out_dir / "cbos.json").write_text(
        json.dumps(
            {
                "catalogo": dict(sorted(used_cbos.items())),
                "por_procedimento": proc_cbos,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    (out_dir / "requisitos.json").write_text(
        json.dumps(
            {
                "servicos": servico_map,
                "classificacoes": serv_class_map,
                "habilitacoes": habilitacao_map,
                "grupos_hab": grupo_hab_map,
                "por_procedimento": requisitos_por_proc,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    (out_dir / "cids.json").write_text(
        json.dumps(
            {
                "catalogo": dict(sorted(used_cids.items())),
                "por_procedimento": proc_cids,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    (out_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return meta


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Atualiza os dados da SIGTAP para o portal estático."
    )
    parser.add_argument(
        "--zip",
        dest="zip_path",
        help="Caminho para um arquivo TabelaUnificada_*.zip local (pula o download).",
    )
    parser.add_argument(
        "--out",
        default="docs/data",
        help="Diretório de saída para os JSONs gerados (padrão: docs/data).",
    )
    parser.add_argument(
        "--tsp-dir",
        dest="tsp_dir",
        help="Diretório local com planilhas .xlsx da Tabela SUS Paulista (AIH/SIA/OPME).",
    )
    parser.add_argument(
        "--skip-tsp",
        action="store_true",
        help="Pula o download/processamento da Tabela SUS Paulista.",
    )
    args = parser.parse_args()

    out_dir = Path(args.out)

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir)

        tsp_files: dict[str, Path] | None = None
        if not args.skip_tsp:
            if args.tsp_dir:
                tsp_dir = Path(args.tsp_dir)
                tsp_files = {}
                for kind in ("aih", "sia", "opme"):
                    matches = sorted(tsp_dir.glob(f"*{kind}*.xlsx"))
                    if matches:
                        tsp_files[kind] = matches[0]
            else:
                try:
                    tsp_files = discover_and_download_tsp(tmp_path)
                except Exception as tsp_err:
                    print(f"Aviso: falha ao baixar Tabela SUS Paulista ({tsp_err}).")

        if args.zip_path:
            zip_path = Path(args.zip_path)
        else:
            try:
                zip_path = download_from_ftp(tmp_path)
            except Exception as ftp_err:
                print(f"Falha no FTP oficial ({ftp_err}).")
                zip_path = download_from_github_mirror(tmp_path)

        meta = build_datasets(zip_path, out_dir, tsp_files=tsp_files)

    print(
        f"Concluído! Competência {meta['competencia_formatada']} "
        f"({meta['total_procedimentos']} procedimentos, "
        f"{meta['total_com_tsp']} com Tabela SUS Paulista) gerada em {out_dir}."
    )


if __name__ == "__main__":
    main()
