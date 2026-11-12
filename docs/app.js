const PAGE_SIZE = 50;

let allProcedures = [];
let procByCode = new Map();
let allSubgrupos = [];
let allFormas = [];
let filteredProcedures = [];
let currentPage = 1;
let descriptionsCache = null;
let compatCache = null;
let cbosCache = null;
let cbosPromise = null;
let cboIndexList = null;
let cidsCache = null;
let cidsPromise = null;
let cidIndexList = null;
let requisitosCache = null;

const els = {
  competenciaPill: document.getElementById("competencia-pill"),
  tspPill: document.getElementById("tsp-pill"),
  totalPill: document.getElementById("total-pill"),
  updatedPill: document.getElementById("updated-pill"),
  searchInput: document.getElementById("search-input"),
  clearBtn: document.getElementById("clear-btn"),
  groupFilter: document.getElementById("group-filter"),
  subgroupFilter: document.getElementById("subgroup-filter"),
  formaFilter: document.getElementById("forma-filter"),
  cpfFilter: document.getElementById("cpf-filter"),
  complexityFilter: document.getElementById("complexity-filter"),
  sexFilter: document.getElementById("sex-filter"),
  registroFilter: document.getElementById("registro-filter"),
  cboFilter: document.getElementById("cbo-filter"),
  cboOptions: document.getElementById("cbo-options"),
  cidFilter: document.getElementById("cid-filter"),
  cidOptions: document.getElementById("cid-options"),
  paidOnly: document.getElementById("paid-only"),
  obrigOnly: document.getElementById("obrig-only"),
  servOnly: document.getElementById("serv-only"),
  habOnly: document.getElementById("hab-only"),
  tspOnly: document.getElementById("tsp-only"),
  resultsCount: document.getElementById("results-count"),
  exportCsvBtn: document.getElementById("export-csv-btn"),
  tbody: document.getElementById("procedures-tbody"),
  pageInfo: document.getElementById("page-info"),
  prevPage: document.getElementById("prev-page"),
  nextPage: document.getElementById("next-page"),
  modalBackdrop: document.getElementById("modal-backdrop"),
  modalCode: document.getElementById("modal-code"),
  modalTitle: document.getElementById("modal-title"),
  modalBody: document.getElementById("modal-body"),
  modalClose: document.getElementById("modal-close"),
};

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeText(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function formatCode(code) {
  if (!code || code.length !== 10) return code;
  return `${code.slice(0, 2)}.${code.slice(2, 4)}.${code.slice(4, 6)}.${code.slice(6, 9)}-${code.slice(9)}`;
}

function formatCurrency(val) {
  return Number(val || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function formatAgeMonths(months) {
  if (months === null || months === undefined) return null;
  if (months === 0) return "0 meses";
  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  if (years === 0) return `${remMonths} ${remMonths === 1 ? "mês" : "meses"}`;
  if (remMonths === 0) return `${years} ${years === 1 ? "ano" : "anos"}`;
  return `${years}a ${remMonths}m`;
}

function formatAgeRange(minM, maxM) {
  const minStr = formatAgeMonths(minM);
  const maxStr = formatAgeMonths(maxM);
  if (!minStr && !maxStr) return "Não se aplica";
  if (minStr && maxStr) return `${minStr} a ${maxStr}`;
  if (minStr) return `A partir de ${minStr}`;
  return `Até ${maxStr}`;
}

function getCpfBadge(proc) {
  const map = {
    obrigatorio_cpf: { cls: "badge-danger", text: "Obrigatório CPF" },
    exige_cpf_cns: { cls: "badge-warn", text: "Exige CPF/CNS" },
    nao_exige: { cls: "badge-ok", text: "Não exige CPF/CNS" },
    nao_especificado: { cls: "badge-neutral", text: "Sem regra específica" },
  };
  const info = map[proc.cpf_status] || map.nao_especificado;
  return `<span class="badge ${info.cls}">${info.text}</span>`;
}

function populateCascadeSelect(selectEl, defaultLabel, items, formatLabel) {
  const prevValue = selectEl.value;
  selectEl.innerHTML = `<option value="">${escapeHtml(defaultLabel)}</option>`;

  let keepPrev = false;
  for (const item of items) {
    const opt = document.createElement("option");
    opt.value = item.codigo;
    opt.textContent = formatLabel(item);
    if (item.codigo === prevValue) keepPrev = true;
    selectEl.appendChild(opt);
  }
  selectEl.value = keepPrev ? prevValue : "";
}

function populateSubgroupFilter(selectedGroup) {
  const items = selectedGroup
    ? allSubgrupos.filter((s) => s.grupo_cod === selectedGroup)
    : allSubgrupos;
  populateCascadeSelect(
    els.subgroupFilter,
    "Todos os subgrupos",
    items,
    (s) => `${s.sub_codigo} - ${s.nome}${selectedGroup ? "" : ` (${s.grupo_cod})`}`
  );
}

function populateFormaFilter(selectedGroup, selectedSubgroup) {
  let items = allFormas;
  if (selectedSubgroup) {
    items = allFormas.filter((f) => f.subgrupo_cod === selectedSubgroup);
  } else if (selectedGroup) {
    items = allFormas.filter((f) => f.grupo_cod === selectedGroup);
  }
  populateCascadeSelect(
    els.formaFilter,
    "Todas as formas de organização",
    items,
    (f) =>
      selectedSubgroup
        ? `${f.forma_codigo} - ${f.nome}`
        : `${f.grupo_cod}.${f.subgrupo_cod.slice(2)}.${f.forma_codigo} - ${f.nome}`
  );
}

function applyFilters() {
  const rawSearch = els.searchInput.value.trim();
  const normSearch = normalizeText(rawSearch);
  const digitsSearch = rawSearch.replace(/\D/g, "");

  const grupo = els.groupFilter.value;
  const subgrupo = els.subgroupFilter.value;
  const forma = els.formaFilter.value;
  const cpf = els.cpfFilter.value;
  const complexidade = els.complexityFilter.value;
  const sexo = els.sexFilter.value;
  const registro = els.registroFilter.value;
  const rawCbo = els.cboFilter.value.trim();
  const rawCid = els.cidFilter.value.trim();
  const onlyPaid = els.paidOnly.checked;
  const onlyObrig = els.obrigOnly.checked;
  const onlyServ = els.servOnly.checked;
  const onlyHab = els.habOnly.checked;
  const onlyTsp = els.tspOnly.checked;

  let matchingCboSet = null;
  if (rawCbo && cbosCache) {
    const cboNorm = normalizeText(rawCbo);
    const codePrefixMatch = rawCbo.match(/^\d{1,6}/);
    const matchedCodes = [];
    if (codePrefixMatch && rawCbo.includes(" - ")) {
      matchedCodes.push(codePrefixMatch[0]);
    } else {
      for (const item of cboIndexList) {
        if (
          (codePrefixMatch && item.code.startsWith(codePrefixMatch[0])) ||
          item.normName.includes(cboNorm)
        ) {
          matchedCodes.push(item.code);
        }
      }
    }
    matchingCboSet = new Set(matchedCodes);
  }

  let matchingCidSet = null;
  if (rawCid && cidsCache) {
    const cidNorm = normalizeText(rawCid);
    const cidCodeInput = rawCid.split(" - ")[0].replace(/\./g, "").toUpperCase();
    const matchedCids = [];
    if (rawCid.includes(" - ") && cidsCache.catalogo[cidCodeInput]) {
      matchedCids.push(cidCodeInput);
    } else {
      const looksLikeCode = /^[A-Z]\d/i.test(cidCodeInput);
      for (const item of cidIndexList) {
        if (
          (looksLikeCode && item.code.startsWith(cidCodeInput)) ||
          item.normName.includes(cidNorm)
        ) {
          matchedCids.push(item.code);
        }
      }
    }
    matchingCidSet = new Set(matchedCids);
  }

  filteredProcedures = allProcedures.filter((p) => {
    if (grupo && p.grupo_cod !== grupo) return false;
    if (subgrupo && p.subgrupo_cod !== subgrupo) return false;
    if (forma && p.forma_cod !== forma) return false;
    if (cpf && p.cpf_status !== cpf) return false;
    if (complexidade && p.complexidade_cod !== complexidade) return false;
    if (sexo && p.sexo_cod !== sexo) return false;
    if (registro && !p.registros.includes(registro)) return false;
    if (onlyPaid && p.vl_sa <= 0 && p.vl_sh <= 0 && p.vl_sp <= 0) return false;
    if (onlyObrig && !(p.qt_obrig > 0)) return false;
    if (onlyServ && !(p.qt_servicos > 0)) return false;
    if (onlyHab && !(p.qt_habilitacoes > 0)) return false;
    if (onlyTsp && !p.tsp) return false;
    if (matchingCboSet) {
      const procCbos = cbosCache.por_procedimento[p.codigo];
      if (!procCbos || !procCbos.some((c) => matchingCboSet.has(c))) {
        return false;
      }
    }
    if (matchingCidSet) {
      const procCids = cidsCache.por_procedimento[p.codigo];
      if (!procCids || !procCids.some(([c]) => matchingCidSet.has(c))) {
        return false;
      }
    }

    if (normSearch) {
      const matchName = p._searchName.includes(normSearch);
      const matchCode =
        p.codigo.includes(digitsSearch || normSearch) ||
        formatCode(p.codigo).includes(rawSearch);
      if (!matchName && !(digitsSearch && p.codigo.includes(digitsSearch)) && !matchCode) {
        return false;
      }
    }
    return true;
  });

  currentPage = 1;
  renderTable();
}

function renderTable() {
  const total = filteredProcedures.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;

  const start = (currentPage - 1) * PAGE_SIZE;
  const slice = filteredProcedures.slice(start, start + PAGE_SIZE);

  els.resultsCount.textContent = `${total.toLocaleString("pt-BR")} procedimento(s) encontrado(s)`;
  els.pageInfo.textContent = `Página ${currentPage} de ${totalPages}`;
  els.prevPage.disabled = currentPage <= 1;
  els.nextPage.disabled = currentPage >= totalPages;

  if (slice.length === 0) {
    els.tbody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-state">
          Nenhum procedimento encontrado com os filtros aplicados.
        </td>
      </tr>
    `;
    return;
  }

  els.tbody.innerHTML = slice
    .map((p) => {
      const regBadges = p.registros
        .slice(0, 3)
        .map((r) => `<span class="badge badge-info">${escapeHtml(r)}</span>`)
        .join("");
      const extraReg =
        p.registros.length > 3
          ? `<span class="badge badge-neutral">+${p.registros.length - 3}</span>`
          : "";
      const obrigBadge =
        p.qt_obrig > 0
          ? `<span class="badge badge-danger">${p.qt_obrig} obrigatório(s)</span>`
          : "";
      const compatBadge =
        p.qt_compat > 0
          ? `<span class="badge badge-neutral">${p.qt_compat} opcional(is)</span>`
          : "";
      const cboBadge = p.nao_exige_cbo
        ? `<span class="badge badge-ok">Não exige CBO</span>`
        : p.qt_cbos > 0
        ? `<span class="badge badge-neutral">${p.qt_cbos} CBO(s)</span>`
        : "";
      const servBadge =
        p.qt_servicos > 0
          ? `<span class="badge badge-warn">Serviço/Class. (${p.qt_servicos})</span>`
          : "";
      const habBadge =
        p.qt_habilitacoes > 0
          ? `<span class="badge badge-warn">Habilitação (${p.qt_habilitacoes})</span>`
          : "";
      const cidBadge =
        p.qt_cids > 0
          ? `<span class="badge badge-neutral">${p.qt_cids} CID(s)</span>`
          : "";

      return `
        <tr data-codigo="${escapeHtml(p.codigo)}">
          <td class="code-cell">
            <span>${escapeHtml(formatCode(p.codigo))}</span>
            <button type="button" class="copy-btn" data-copy="${escapeHtml(p.codigo)}" title="Copiar código sem pontuação">Copiar</button>
          </td>
          <td>
            <div class="proc-name">${escapeHtml(p.nome)}</div>
            <div class="proc-sub">${escapeHtml(p.grupo)} · ${escapeHtml(p.subgrupo)}</div>
            <div class="badges-row">
              <span class="badge badge-neutral">${escapeHtml(p.complexidade)}</span>
              ${regBadges}${extraReg}${obrigBadge}${compatBadge}${cboBadge}${servBadge}${habBadge}${cidBadge}
            </div>
          </td>
          <td>
            <div>${escapeHtml(formatAgeRange(p.idade_min, p.idade_max))}</div>
            <div class="proc-sub">Sexo: ${escapeHtml(p.sexo)}</div>
          </td>
          <td>
            ${getCpfBadge(p)}
            ${
              p.validade_apac
                ? `<div class="badges-row"><span class="badge badge-warn">Validade APAC: ${escapeHtml(p.validade_apac)}</span></div>`
                : ""
            }
            ${
              p.detalhes.includes("Exige Autorização")
                ? '<div class="badges-row"><span class="badge badge-neutral">Exige Autorização</span></div>'
                : ""
            }
          </td>
          <td class="values-cell">
            <div class="val-line"><span class="val-label">SA:</span><span class="val-num">${formatCurrency(p.vl_sa)}</span></div>
            <div class="val-line"><span class="val-label">SH:</span><span class="val-num">${formatCurrency(p.vl_sh)}</span></div>
            <div class="val-line"><span class="val-label">SP:</span><span class="val-num">${formatCurrency(p.vl_sp)}</span></div>
          </td>
          <td class="values-cell">${renderTspCell(p)}</td>
        </tr>
      `;
    })
    .join("");
}

async function loadDescriptions() {
  if (descriptionsCache) return descriptionsCache;
  const resp = await fetch("data/descricoes.json");
  if (!resp.ok) throw new Error("Não foi possível carregar as descrições.");
  descriptionsCache = await resp.json();
  return descriptionsCache;
}

async function loadCompatibilidades() {
  if (compatCache) return compatCache;
  const resp = await fetch("data/compatibilidades.json");
  if (!resp.ok) throw new Error("Não foi possível carregar as compatibilidades.");
  compatCache = await resp.json();
  return compatCache;
}

async function loadRequisitos() {
  if (requisitosCache) return requisitosCache;
  const resp = await fetch("data/requisitos.json");
  if (!resp.ok) throw new Error("Não foi possível carregar serviços e habilitações.");
  requisitosCache = await resp.json();
  return requisitosCache;
}

async function loadCbos() {
  if (cbosCache) return cbosCache;
  if (!cbosPromise) {
    cbosPromise = fetch("data/cbos.json")
      .then((resp) => {
        if (!resp.ok) throw new Error("Não foi possível carregar os CBOs.");
        return resp.json();
      })
      .then((data) => {
        cbosCache = data;
        cboIndexList = Object.entries(data.catalogo).map(([code, name]) => ({
          code,
          name,
          normName: normalizeText(name),
        }));
        const frag = document.createDocumentFragment();
        for (const item of cboIndexList) {
          const opt = document.createElement("option");
          opt.value = `${item.code} - ${item.name}`;
          frag.appendChild(opt);
        }
        els.cboOptions.appendChild(frag);
        return cbosCache;
      })
      .catch((err) => {
        cbosPromise = null;
        throw err;
      });
  }
  return cbosPromise;
}

function formatCid(code) {
  if (!code) return "";
  return code.length === 4 ? `${code.slice(0, 3)}.${code.slice(3)}` : code;
}

async function loadCids() {
  if (cidsCache) return cidsCache;
  if (!cidsPromise) {
    cidsPromise = fetch("data/cids.json")
      .then((resp) => {
        if (!resp.ok) throw new Error("Não foi possível carregar os CIDs.");
        return resp.json();
      })
      .then((data) => {
        cidsCache = data;
        cidIndexList = Object.entries(data.catalogo).map(([code, name]) => ({
          code,
          formatted: formatCid(code),
          name,
          normName: normalizeText(name),
        }));
        const frag = document.createDocumentFragment();
        for (const item of cidIndexList) {
          const opt = document.createElement("option");
          opt.value = `${item.formatted} - ${item.name}`;
          frag.appendChild(opt);
        }
        els.cidOptions.appendChild(frag);
        return cidsCache;
      })
      .catch((err) => {
        cidsPromise = null;
        throw err;
      });
  }
  return cidsPromise;
}

function renderServicosSection(reqData, codigo) {
  const pairs = reqData.por_procedimento[codigo]?.s || [];
  if (pairs.length === 0) {
    return '<span class="proc-sub">Nenhum Serviço/Classificação exigido.</span>';
  }
  const itemsHtml = pairs
    .map(([coServ, coClass]) => {
      const servNome = reqData.servicos[coServ] || coServ;
      const classNome = reqData.classificacoes[`${coServ}|${coClass}`] || coClass;
      return `
        <li class="compat-item">
          <div>
            <strong>${escapeHtml(coServ)}/${escapeHtml(coClass)}</strong> — ${escapeHtml(servNome)}
            <div class="compat-meta">Classificação: ${escapeHtml(classNome)}</div>
          </div>
        </li>
      `;
    })
    .join("");
  return `<ul class="compat-list">${itemsHtml}</ul>`;
}

function renderHabilitacoesSection(reqData, codigo) {
  const pairs = reqData.por_procedimento[codigo]?.h || [];
  if (pairs.length === 0) {
    return '<span class="proc-sub">Nenhuma Habilitação exigida.</span>';
  }
  const byGroup = new Map();
  for (const [coHab, nuGrupo] of pairs) {
    const key = nuGrupo || "";
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(coHab);
  }
  return Array.from(byGroup.entries())
    .map(([nuGrupo, habCodes]) => {
      const grpInfo = nuGrupo ? reqData.grupos_hab[nuGrupo] : null;
      const titleText = grpInfo
        ? `Grupo ${nuGrupo}${grpInfo.nome ? ` (${grpInfo.nome})` : ""}`
        : "Habilitações exigidas";
      const descHint = grpInfo?.desc
        ? `<div class="compat-meta" style="margin-bottom:0.35rem;">${escapeHtml(grpInfo.desc)}</div>`
        : "";
      const listHtml = habCodes
        .map((coHab) => {
          const nome = reqData.habilitacoes[coHab] || coHab;
          return `
            <li class="compat-item">
              <div><span class="cbo-code">${escapeHtml(coHab)}</span>${escapeHtml(nome)}</div>
            </li>
          `;
        })
        .join("");
      return `
        <div class="compat-group">
          <div class="compat-group-title">
            <span class="badge badge-warn">${escapeHtml(titleText)}</span>
            <span class="compat-meta">(${habCodes.length})</span>
          </div>
          ${descHint}
          <ul class="compat-list">${listHtml}</ul>
        </div>
      `;
    })
    .join("");
}

function mountFilterableList(containerEl, { items, countLabel, searchPlaceholder, renderItem }) {
  const MAX_RENDER = 250;
  containerEl.innerHTML = `
    <div class="compat-meta" style="margin-bottom:0.35rem;">${escapeHtml(countLabel)}</div>
    ${
      items.length > 8
        ? `<input class="cbo-filter-input" type="search" placeholder="${escapeHtml(searchPlaceholder)}">`
        : ""
    }
    <div class="cbo-scroll">
      <ul class="cbo-list"></ul>
    </div>
    <div class="compat-meta list-cap-note" style="margin-top:0.35rem;"></div>
  `;

  const inputEl = containerEl.querySelector(".cbo-filter-input");
  const listEl = containerEl.querySelector(".cbo-list");
  const noteEl = containerEl.querySelector(".list-cap-note");

  function renderSlice(term) {
    const matches = term ? items.filter((i) => i.searchKey.includes(term)) : items;
    const shown = matches.slice(0, MAX_RENDER);
    listEl.innerHTML = shown.length
      ? shown.map(renderItem).join("")
      : '<li class="proc-sub">Nenhum item encontrado para essa busca.</li>';
    noteEl.textContent =
      matches.length > MAX_RENDER
        ? `Mostrando os primeiros ${MAX_RENDER} de ${matches.length} itens — refine a busca acima para ver outros.`
        : "";
  }

  renderSlice("");
  if (inputEl) {
    inputEl.addEventListener("input", () => {
      const term = normalizeText(inputEl.value.trim()).replace(/\./g, "");
      renderSlice(term);
    });
  }
}

function renderCbosInto(containerEl, cboData, proc) {
  if (proc.nao_exige_cbo) {
    containerEl.innerHTML =
      '<span class="badge badge-ok">Não Exige CBO (qualquer ocupação permitida)</span>';
    return;
  }
  const codes = cboData.por_procedimento[proc.codigo] || [];
  if (codes.length === 0) {
    containerEl.innerHTML =
      '<span class="proc-sub">Nenhum CBO específico vinculado a este procedimento.</span>';
    return;
  }
  const items = codes.map((code) => {
    const name = cboData.catalogo[code] || code;
    return {
      code,
      name,
      searchKey: normalizeText(`${code} ${name}`),
    };
  });
  mountFilterableList(containerEl, {
    items,
    countLabel: `${items.length} CBO(s) permitido(s)`,
    searchPlaceholder: "Filtrar CBOs deste procedimento (código ou nome)...",
    renderItem: (i) =>
      `<li><span class="cbo-code">${escapeHtml(i.code)}</span>${escapeHtml(i.name)}</li>`,
  });
}

function renderCidsInto(containerEl, cidData, codigo) {
  const pairs = cidData.por_procedimento[codigo] || [];
  if (pairs.length === 0) {
    containerEl.innerHTML =
      '<span class="proc-sub">Nenhuma lista fechada de CIDs vinculada a este procedimento.</span>';
    return;
  }
  const items = pairs.map(([code, st]) => {
    const name = cidData.catalogo[code] || code;
    const formatted = formatCid(code);
    return {
      code,
      formatted,
      name,
      principal: st === "S",
      searchKey: normalizeText(`${code} ${formatted} ${name}`).replace(/\./g, ""),
    };
  });
  mountFilterableList(containerEl, {
    items,
    countLabel: `${items.length} CID(s) permitido(s)`,
    searchPlaceholder: "Filtrar CIDs deste procedimento (código ou descrição)...",
    renderItem: (i) => `
      <li class="cid-item">
        <div><span class="cbo-code">${escapeHtml(i.formatted)}</span>${escapeHtml(i.name)}</div>
        <span class="badge ${i.principal ? "badge-info" : "badge-neutral"}">${
      i.principal ? "Principal" : "Secundário"
    }</span>
      </li>
    `,
  });
}

const COMPAT_GROUPS = [
  { tipo: "5", label: "Secundários / Especiais Obrigatórios", cls: "badge-danger" },
  { tipo: "1", label: "Compatíveis / Opcionais", cls: "badge-info" },
  { tipo: "3", label: "Concomitantes", cls: "badge-ok" },
  { tipo: "4", label: "Sequenciais", cls: "badge-neutral" },
  { tipo: "2", label: "Incompatíveis / Excludentes", cls: "badge-warn" },
];

function renderCompatSection(items, proc) {
  if (!items || items.length === 0) {
    return '<span class="proc-sub">Nenhuma regra de compatibilidade vinculada a este procedimento como principal.</span>';
  }

  let ociAlert = "";
  if (proc?.grupo_cod === "09") {
    const codes = new Set(items.map((i) => i.codigo));
    const hasPresencial = codes.has("0301010072");
    const hasTele = codes.has("0301010307");
    if (hasPresencial || hasTele) {
      ociAlert = `
        <div class="alert-box" style="margin-bottom:0.75rem;">
          <span style="font-size:1.1rem;line-height:1;">ℹ️</span>
          <div>
            <div><strong>Regra OCI (Programa Mais Acesso a Especialistas):</strong></div>
            <div style="font-size:0.82rem;margin-top:0.2rem;">
              Para faturamento da APAC de OCI, é <strong>obrigatório</strong> o registro de no mínimo dois procedimentos secundários, sendo <strong>pelo menos uma Consulta Médica (03.01.01.007-2) OU Teleconsulta (03.01.01.030-7)</strong>. No SIGTAP ambas constam tecnicamente com tipo opcional apenas para permitir a alternância entre a modalidade presencial e a distância no SIA.
            </div>
          </div>
        </div>
      `;
    }
  }

  const groupsHtml = COMPAT_GROUPS.map((grp) => {
    const groupItems = items.filter((i) => i.tipo === grp.tipo);
    if (groupItems.length === 0) return "";
    const listHtml = groupItems
      .map((item) => {
        const refProc = procByCode.get(item.codigo);
        const nome = refProc ? refProc.nome : "Procedimento";
        const qtText = item.qt > 0 ? `Qtd. máx: ${item.qt}` : "";
        const regText = `${item.reg_p} → ${item.reg_c}`;
        const metaParts = [regText, qtText].filter(Boolean).join(" · ");
        return `
          <li class="compat-item">
            <div>
              <button type="button" class="compat-link" data-open-proc="${escapeHtml(item.codigo)}">
                ${escapeHtml(formatCode(item.codigo))} — ${escapeHtml(nome)}
              </button>
              <div class="compat-meta">${escapeHtml(metaParts)}</div>
            </div>
          </li>
        `;
      })
      .join("");

    return `
      <div class="compat-group">
        <div class="compat-group-title">
          <span class="badge ${grp.cls}">${escapeHtml(grp.label)}</span>
          <span class="compat-meta">(${groupItems.length})</span>
        </div>
        <ul class="compat-list">${listHtml}</ul>
      </div>
    `;
  }).join("");

  return ociAlert + groupsHtml;
}

function getTspDefasadoInfo(proc) {
  const tsp = proc?.tsp;
  if (!tsp) return null;
  const defasagens = [];
  if (tsp.sia && proc.vl_sa > 0 && tsp.sia.total < proc.vl_sa) {
    defasagens.push({
      tipo: "SIA",
      tspTotal: tsp.sia.total,
      sigtap: proc.vl_sa,
      msPlanilha: tsp.sia.ms,
    });
  }
  if (tsp.aih && proc.vl_hosp_total > 0 && tsp.aih.total < proc.vl_hosp_total) {
    defasagens.push({
      tipo: "AIH",
      tspTotal: tsp.aih.total,
      sigtap: proc.vl_hosp_total,
      msPlanilha: tsp.aih.ms,
    });
  }
  return defasagens.length > 0 ? defasagens : null;
}

function renderTspCell(proc) {
  const tsp = proc?.tsp;
  if (!tsp) return '<span class="proc-sub">—</span>';
  const lines = [];
  if (tsp.sia) {
    lines.push(
      `<div class="val-line"><span class="val-label">SIA:</span><span class="val-num">${formatCurrency(tsp.sia.total)}</span></div>`
    );
  }
  if (tsp.aih) {
    lines.push(
      `<div class="val-line"><span class="val-label">AIH:</span><span class="val-num">${formatCurrency(tsp.aih.total)}</span></div>`
    );
  }
  if (tsp.opme) {
    lines.push(
      `<div class="val-line"><span class="val-label">OPME:</span><span class="val-num">${formatCurrency(tsp.opme.total)}</span></div>`
    );
  }

  const defasado = getTspDefasadoInfo(proc);
  if (defasado) {
    lines.push(
      `<div class="badges-row"><span class="badge badge-warn" title="O valor atual na SIGTAP é maior do que o publicado na Tabela SUS Paulista.">⚠️ Defasado (MS &gt; SP)</span></div>`
    );
  }

  return lines.join("") || '<span class="proc-sub">—</span>';
}

function renderTspModalSection(proc) {
  const tsp = proc?.tsp;
  if (!tsp) {
    return '<span class="proc-sub">Este procedimento não possui complementação na Tabela SUS Paulista.</span>';
  }
  const blocks = [];

  const defasado = getTspDefasadoInfo(proc);
  if (defasado) {
    const desc = defasado
      .map(
        (d) =>
          `<strong>${d.tipo}:</strong> Valor atual SIGTAP = ${formatCurrency(d.sigtap)} vs. Tabela SUS Paulista = ${formatCurrency(d.tspTotal)} (calculado sobre base anterior do MS de ${formatCurrency(d.msPlanilha)}).`
      )
      .join("<br>");
    blocks.push(`
      <div class="alert-box">
        <span style="font-size:1.1rem;line-height:1;">⚠️</span>
        <div>
          <div><strong>Atenção: Defasado (MS &gt; SP)</strong></div>
          <div style="font-size:0.82rem;margin-top:0.2rem;">${desc} A planilha vigente da SES-SP ainda utiliza uma competência anterior do Ministério da Saúde.</div>
        </div>
      </div>
    `);
  }

  if (tsp.sia) {
    blocks.push(`
      <div style="margin-bottom:0.65rem;">
        <div class="compat-meta" style="margin-bottom:0.35rem;font-weight:600;">SIA (Ambulatorial)</div>
        <div class="detail-grid">
          <div class="detail-box"><div class="lbl">Tabela SUS Paulista</div><div class="val">${formatCurrency(tsp.sia.total)}</div></div>
          <div class="detail-box"><div class="lbl">Tab SUS MS</div><div class="val">${formatCurrency(tsp.sia.ms)}</div></div>
          <div class="detail-box"><div class="lbl">Complementação TSP</div><div class="val">${formatCurrency(tsp.sia.compl)}</div></div>
        </div>
      </div>
    `);
  }
  if (tsp.aih) {
    blocks.push(`
      <div style="margin-bottom:0.65rem;">
        <div class="compat-meta" style="margin-bottom:0.35rem;font-weight:600;">AIH (Hospitalar)</div>
        <div class="detail-grid">
          <div class="detail-box"><div class="lbl">Tab Paulista (Total)</div><div class="val">${formatCurrency(tsp.aih.total)}</div></div>
          <div class="detail-box"><div class="lbl">SH Paulista</div><div class="val">${formatCurrency(tsp.aih.sh)}</div></div>
          <div class="detail-box"><div class="lbl">SP Paulista</div><div class="val">${formatCurrency(tsp.aih.sp)}</div></div>
          <div class="detail-box"><div class="lbl">Tab SUS MS</div><div class="val">${formatCurrency(tsp.aih.ms)}</div></div>
          <div class="detail-box"><div class="lbl">Complementação TSP</div><div class="val">${formatCurrency(tsp.aih.compl)}</div></div>
        </div>
      </div>
    `);
  }
  if (tsp.opme) {
    blocks.push(`
      <div>
        <div class="compat-meta" style="margin-bottom:0.35rem;font-weight:600;">OPME</div>
        <div class="detail-grid">
          <div class="detail-box"><div class="lbl">Tab Paulista</div><div class="val">${formatCurrency(tsp.opme.total)}</div></div>
          <div class="detail-box"><div class="lbl">Tab MS</div><div class="val">${formatCurrency(tsp.opme.ms)}</div></div>
          <div class="detail-box"><div class="lbl">Complementação TSP</div><div class="val">${formatCurrency(tsp.opme.compl)}</div></div>
        </div>
      </div>
    `);
  }
  return blocks.join("");
}

async function openModal(codigo) {
  const proc = procByCode.get(codigo) || allProcedures.find((p) => p.codigo === codigo);
  if (!proc) return;

  els.modalCode.textContent = `${formatCode(proc.codigo)} (${proc.codigo})`;
  els.modalTitle.textContent = proc.nome;
  els.modalBackdrop.hidden = false;

  const detalhesHtml = proc.detalhes.length
    ? proc.detalhes
        .map((d) => `<span class="badge badge-neutral">${escapeHtml(d)}</span>`)
        .join(" ")
    : '<span class="proc-sub">Nenhum detalhe adicional vinculado.</span>';

  const registrosHtml = proc.registros.length
    ? proc.registros
        .map((r) => `<span class="badge badge-info">${escapeHtml(r)}</span>`)
        .join(" ")
    : '<span class="proc-sub">Não informado</span>';

  const modalidadesHtml = proc.modalidades.length
    ? proc.modalidades
        .map((m) => `<span class="badge badge-neutral">${escapeHtml(m)}</span>`)
        .join(" ")
    : '<span class="proc-sub">Não informado</span>';

  els.modalBody.innerHTML = `
    <section class="modal-section">
      <h3 class="modal-section-title">Valores e Regras Gerais</h3>
      <div class="detail-grid">
        <div class="detail-box"><div class="lbl">Valor Ambulatorial (SA)</div><div class="val">${formatCurrency(proc.vl_sa)}</div></div>
        <div class="detail-box"><div class="lbl">Valor Hospitalar (SH)</div><div class="val">${formatCurrency(proc.vl_sh)}</div></div>
        <div class="detail-box"><div class="lbl">Valor Profissional (SP)</div><div class="val">${formatCurrency(proc.vl_sp)}</div></div>
        <div class="detail-box"><div class="lbl">Total Hospitalar (SH+SP)</div><div class="val">${formatCurrency(proc.vl_hosp_total)}</div></div>
        <div class="detail-box"><div class="lbl">Faixa Etária</div><div class="val">${escapeHtml(formatAgeRange(proc.idade_min, proc.idade_max))}</div></div>
        <div class="detail-box"><div class="lbl">Sexo Permitido</div><div class="val">${escapeHtml(proc.sexo)}</div></div>
        <div class="detail-box"><div class="lbl">CPF / CNS</div><div class="val">${getCpfBadge(proc)}</div></div>
        <div class="detail-box"><div class="lbl">Complexidade</div><div class="val">${escapeHtml(proc.complexidade)}</div></div>
        <div class="detail-box"><div class="lbl">Financiamento</div><div class="val">${escapeHtml(proc.financiamento || "—")}</div></div>
        <div class="detail-box"><div class="lbl">Qtd. Máxima</div><div class="val">${proc.qt_max ?? "Não se aplica"}</div></div>
        <div class="detail-box"><div class="lbl">Dias Permanência</div><div class="val">${proc.qt_dias_perm ?? "Não se aplica"}</div></div>
        <div class="detail-box"><div class="lbl">Pontos</div><div class="val">${proc.qt_pontos ?? 0}</div></div>
        <div class="detail-box"><div class="lbl">Validade APAC</div><div class="val">${
          proc.validade_apac
            ? `<span class="badge badge-warn">${escapeHtml(proc.validade_apac)}</span>`
            : "Não especificada"
        }</div></div>
      </div>
    </section>

    <section class="modal-section">
      <h3 class="modal-section-title">Tabela SUS Paulista</h3>
      ${renderTspModalSection(proc)}
    </section>

    <section class="modal-section">
      <h3 class="modal-section-title">Classificação e Registro</h3>
      <p style="margin:0 0 0.7rem;font-size:0.88rem;">
        <strong>Grupo:</strong> ${escapeHtml(proc.grupo)}<br>
        <strong>Subgrupo:</strong> ${escapeHtml(proc.subgrupo)}<br>
        <strong>Forma de Organização:</strong> ${escapeHtml(proc.forma || "—")}
      </p>
      <div style="margin-bottom:0.55rem;">
        <div class="compat-meta" style="margin-bottom:0.25rem;font-weight:600;">Instrumentos de Registro</div>
        <div class="badges-row">${registrosHtml}</div>
      </div>
      <div style="margin-bottom:0.55rem;">
        <div class="compat-meta" style="margin-bottom:0.25rem;font-weight:600;">Modalidades de Atendimento</div>
        <div class="badges-row">${modalidadesHtml}</div>
      </div>
      <div>
        <div class="compat-meta" style="margin-bottom:0.25rem;font-weight:600;">Atributos / Detalhes SIGTAP</div>
        <div class="badges-row">${detalhesHtml}</div>
      </div>
    </section>

    <section class="modal-section">
      <h3 class="modal-section-title">Serviço / Classificação</h3>
      <div id="modal-servicos" class="proc-sub">Carregando serviços/classificações...</div>
    </section>

    <section class="modal-section">
      <h3 class="modal-section-title">Habilitações</h3>
      <div id="modal-habilitacoes" class="proc-sub">Carregando habilitações...</div>
    </section>

    <section class="modal-section">
      <h3 class="modal-section-title">CBOs Permitidos</h3>
      <div id="modal-cbos" class="proc-sub">Carregando CBOs...</div>
    </section>

    <section class="modal-section">
      <h3 class="modal-section-title">CIDs Permitidos (CID-10)</h3>
      <div id="modal-cids" class="proc-sub">Carregando CIDs...</div>
    </section>

    <section class="modal-section">
      <h3 class="modal-section-title">Compatibilidades / Secundários (Obrigatórios e Opcionais)</h3>
      <div id="modal-compat" class="proc-sub">Carregando compatibilidades...</div>
    </section>

    <section class="modal-section">
      <h3 class="modal-section-title">Descrição Oficial</h3>
      <div id="modal-desc" class="desc-text">Carregando descrição...</div>
    </section>
  `;

  try {
    const [descs, compats, reqData, cboData, cidData] = await Promise.all([
      loadDescriptions(),
      loadCompatibilidades(),
      loadRequisitos(),
      loadCbos(),
      loadCids(),
    ]);
    const servEl = document.getElementById("modal-servicos");
    if (servEl) {
      servEl.innerHTML = renderServicosSection(reqData, codigo);
    }
    const habEl = document.getElementById("modal-habilitacoes");
    if (habEl) {
      habEl.innerHTML = renderHabilitacoesSection(reqData, codigo);
    }
    const cboEl = document.getElementById("modal-cbos");
    if (cboEl) {
      renderCbosInto(cboEl, cboData, proc);
    }
    const cidEl = document.getElementById("modal-cids");
    if (cidEl) {
      renderCidsInto(cidEl, cidData, codigo);
    }
    const compatEl = document.getElementById("modal-compat");
    if (compatEl) {
      compatEl.innerHTML = renderCompatSection(compats[codigo] || [], proc);
    }
    const descEl = document.getElementById("modal-desc");
    if (descEl) {
      descEl.textContent = descs[codigo] || "Sem descrição cadastrada no SIGTAP.";
    }
  } catch {
    for (const id of ["modal-servicos", "modal-habilitacoes", "modal-cbos", "modal-cids", "modal-compat"]) {
      const el = document.getElementById(id);
      if (el) el.textContent = "Não foi possível carregar estes dados.";
    }
    const descEl = document.getElementById("modal-desc");
    if (descEl) descEl.textContent = "Não foi possível carregar a descrição.";
  }
}

function exportCsv() {
  const headers = [
    "Codigo",
    "Codigo_Formatado",
    "Nome",
    "Grupo",
    "Subgrupo",
    "Forma_Organizacao",
    "Complexidade",
    "Sexo",
    "Idade_Min_Meses",
    "Idade_Max_Meses",
    "CPF_CNS",
    "Valor_SA",
    "Valor_SH",
    "Valor_SP",
    "TSP_SIA",
    "TSP_AIH",
    "TSP_OPME",
    "Financiamento",
    "Registros",
  ];

  const csvCell = (val) => `"${String(val ?? "").replace(/"/g, '""')}"`;

  const lines = [headers.join(";")];
  for (const p of filteredProcedures) {
    lines.push(
      [
        p.codigo,
        formatCode(p.codigo),
        p.nome,
        p.grupo,
        p.subgrupo,
        p.forma,
        p.complexidade,
        p.sexo,
        p.idade_min ?? "",
        p.idade_max ?? "",
        p.cpf_label,
        p.vl_sa.toFixed(2).replace(".", ","),
        p.vl_sh.toFixed(2).replace(".", ","),
        p.vl_sp.toFixed(2).replace(".", ","),
        p.tsp?.sia ? p.tsp.sia.total.toFixed(2).replace(".", ",") : "",
        p.tsp?.aih ? p.tsp.aih.total.toFixed(2).replace(".", ",") : "",
        p.tsp?.opme ? p.tsp.opme.total.toFixed(2).replace(".", ",") : "",
        p.financiamento,
        p.registros.join(" | "),
      ]
        .map(csvCell)
        .join(";")
    );
  }

  const blob = new Blob(["\uFEFF" + lines.join("\n")], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "sigtap_procedimentos_filtrados.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function setupEvents() {
  let debounceTimer;
  els.searchInput.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(applyFilters, 180);
  });

  els.groupFilter.addEventListener("change", () => {
    populateSubgroupFilter(els.groupFilter.value);
    populateFormaFilter(els.groupFilter.value, els.subgroupFilter.value);
    applyFilters();
  });

  els.subgroupFilter.addEventListener("change", () => {
    populateFormaFilter(els.groupFilter.value, els.subgroupFilter.value);
    applyFilters();
  });

  for (const el of [
    els.formaFilter,
    els.cpfFilter,
    els.complexityFilter,
    els.sexFilter,
    els.registroFilter,
    els.paidOnly,
    els.obrigOnly,
    els.servOnly,
    els.habOnly,
    els.tspOnly,
  ]) {
    el.addEventListener("change", applyFilters);
  }

  let cboDebounce;
  els.cboFilter.addEventListener("focus", () => {
    loadCbos().catch(() => {});
  });
  els.cboFilter.addEventListener("input", () => {
    clearTimeout(cboDebounce);
    cboDebounce = setTimeout(async () => {
      if (els.cboFilter.value.trim()) {
        await loadCbos();
      }
      applyFilters();
    }, 200);
  });

  let cidDebounce;
  els.cidFilter.addEventListener("focus", () => {
    loadCids().catch(() => {});
  });
  els.cidFilter.addEventListener("input", () => {
    clearTimeout(cidDebounce);
    cidDebounce = setTimeout(async () => {
      if (els.cidFilter.value.trim()) {
        await loadCids();
      }
      applyFilters();
    }, 200);
  });

  els.clearBtn.addEventListener("click", () => {
    els.searchInput.value = "";
    els.groupFilter.value = "";
    populateSubgroupFilter("");
    els.subgroupFilter.value = "";
    populateFormaFilter("", "");
    els.formaFilter.value = "";
    els.cpfFilter.value = "";
    els.complexityFilter.value = "";
    els.sexFilter.value = "";
    els.registroFilter.value = "";
    els.cboFilter.value = "";
    els.cidFilter.value = "";
    els.paidOnly.checked = false;
    els.obrigOnly.checked = false;
    els.servOnly.checked = false;
    els.habOnly.checked = false;
    els.tspOnly.checked = false;
    applyFilters();
  });

  els.prevPage.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      renderTable();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  els.nextPage.addEventListener("click", () => {
    const totalPages = Math.ceil(filteredProcedures.length / PAGE_SIZE);
    if (currentPage < totalPages) {
      currentPage++;
      renderTable();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  els.tbody.addEventListener("click", (e) => {
    const copyBtn = e.target.closest("[data-copy]");
    if (copyBtn) {
      e.stopPropagation();
      const code = copyBtn.getAttribute("data-copy");
      navigator.clipboard?.writeText(code);
      copyBtn.textContent = "Copiado!";
      setTimeout(() => {
        copyBtn.textContent = "Copiar";
      }, 1200);
      return;
    }

    const row = e.target.closest("tr[data-codigo]");
    if (row) {
      openModal(row.getAttribute("data-codigo"));
    }
  });

  els.exportCsvBtn.addEventListener("click", exportCsv);

  els.modalBody.addEventListener("click", (e) => {
    const link = e.target.closest("[data-open-proc]");
    if (link) {
      openModal(link.getAttribute("data-open-proc"));
    }
  });

  els.modalClose.addEventListener("click", () => {
    els.modalBackdrop.hidden = true;
  });

  els.modalBackdrop.addEventListener("click", (e) => {
    if (e.target === els.modalBackdrop) {
      els.modalBackdrop.hidden = true;
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.modalBackdrop.hidden) {
      els.modalBackdrop.hidden = true;
    }
  });
}

async function init() {
  setupEvents();
  try {
    const [metaResp, procResp] = await Promise.all([
      fetch("data/meta.json"),
      fetch("data/procedimentos.json"),
    ]);
    if (!metaResp.ok || !procResp.ok) {
      throw new Error("Erro ao carregar os arquivos JSON da SIGTAP.");
    }

    const meta = await metaResp.json();
    const procs = await procResp.json();

    els.competenciaPill.textContent = `Competência: ${meta.competencia_formatada}`;
    els.tspPill.textContent = meta.tsp_referencia
      ? `SUS Paulista: ${meta.tsp_referencia}`
      : "SUS Paulista: —";
    els.totalPill.textContent = `${meta.total_procedimentos.toLocaleString("pt-BR")} procedimentos`;
    const dt = new Date(meta.atualizado_em);
    els.updatedPill.textContent = `Atualizado: ${dt.toLocaleDateString("pt-BR")}`;

    for (const g of meta.grupos || []) {
      const opt = document.createElement("option");
      opt.value = g.codigo;
      opt.textContent = `${g.codigo} - ${g.nome}`;
      els.groupFilter.appendChild(opt);
    }

    allSubgrupos = meta.subgrupos || [];
    populateSubgroupFilter("");

    allFormas = meta.formas_organizacao || [];
    populateFormaFilter("", "");

    for (const r of meta.registros || []) {
      const opt = document.createElement("option");
      opt.value = r;
      opt.textContent = r;
      els.registroFilter.appendChild(opt);
    }

    allProcedures = procs.map((p) => ({
      ...p,
      _searchName: normalizeText(p.nome),
    }));
    procByCode = new Map(allProcedures.map((p) => [p.codigo, p]));
    filteredProcedures = allProcedures;
    renderTable();
  } catch (err) {
    els.tbody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-state">
          Falha ao carregar os dados: ${escapeHtml(err.message)}
        </td>
      </tr>
    `;
  }
}

init();
