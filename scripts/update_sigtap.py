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
import zipfile
from datetime import datetime, timezone
from pathlib import Path

FTP_HOST = "ftp2.datasus.gov.br"
FTP_DIR = "/pub/sistemas/tup/downloads/"
GITHUB_MIRROR_API = "https://api.github.com/repos/RenatoKR/SIGTAP/contents/tabelas"

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


def build_datasets(zip_path: Path, out_dir: Path) -> dict[str, object]:
    """Processa o arquivo ZIP do SIGTAP e gera os JSONs de saída."""
    out_dir.mkdir(parents=True, exist_ok=True)

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

        procedimentos.append(
            {
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
        )

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
    args = parser.parse_args()

    out_dir = Path(args.out)

    if args.zip_path:
        zip_path = Path(args.zip_path)
        meta = build_datasets(zip_path, out_dir)
    else:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            try:
                zip_path = download_from_ftp(tmp_path)
            except Exception as ftp_err:
                print(f"Falha no FTP oficial ({ftp_err}).")
                zip_path = download_from_github_mirror(tmp_path)
            meta = build_datasets(zip_path, out_dir)

    print(
        f"Concluído! Competência {meta['competencia_formatada']} "
        f"({meta['total_procedimentos']} procedimentos) gerada em {out_dir}."
    )


if __name__ == "__main__":
    main()
