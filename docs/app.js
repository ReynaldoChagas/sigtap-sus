const PAGE_SIZE = 50;

let allProcedures = [];
let procByCode = new Map();
let allSubgrupos = [];
let filteredProcedures = [];
let currentPage = 1;
let descriptionsCache = null;
let compatCache = null;

const els = {
  competenciaPill: document.getElementById("competencia-pill"),
  totalPill: document.getElementById("total-pill"),
  updatedPill: document.getElementById("updated-pill"),
  searchInput: document.getElementById("search-input"),
  clearBtn: document.getElementById("clear-btn"),
  groupFilter: document.getElementById("group-filter"),
  subgroupFilter: document.getElementById("subgroup-filter"),
  cpfFilter: document.getElementById("cpf-filter"),
  complexityFilter: document.getElementById("complexity-filter"),
  sexFilter: document.getElementById("sex-filter"),
  registroFilter: document.getElementById("registro-filter"),
  paidOnly: document.getElementById("paid-only"),
  obrigOnly: document.getElementById("obrig-only"),
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

function populateSubgroupFilter(selectedGroup) {
  const prevValue = els.subgroupFilter.value;
  els.subgroupFilter.innerHTML = '<option value="">Todos os subgrupos</option>';

  const items = selectedGroup
    ? allSubgrupos.filter((s) => s.grupo_cod === selectedGroup)
    : allSubgrupos;

  let keepPrev = false;
  for (const s of items) {
    const opt = document.createElement("option");
    opt.value = s.codigo;
    opt.textContent = `${s.grupo_cod}.${s.sub_codigo} - ${s.nome}`;
    if (s.codigo === prevValue) keepPrev = true;
    els.subgroupFilter.appendChild(opt);
  }
  els.subgroupFilter.value = keepPrev ? prevValue : "";
}

function applyFilters() {
  const rawSearch = els.searchInput.value.trim();
  const normSearch = normalizeText(rawSearch);
  const digitsSearch = rawSearch.replace(/\D/g, "");

  const grupo = els.groupFilter.value;
  const subgrupo = els.subgroupFilter.value;
  const cpf = els.cpfFilter.value;
  const complexidade = els.complexityFilter.value;
  const sexo = els.sexFilter.value;
  const registro = els.registroFilter.value;
  const onlyPaid = els.paidOnly.checked;
  const onlyObrig = els.obrigOnly.checked;

  filteredProcedures = allProcedures.filter((p) => {
    if (grupo && p.grupo_cod !== grupo) return false;
    if (subgrupo && p.subgrupo_cod !== subgrupo) return false;
    if (cpf && p.cpf_status !== cpf) return false;
    if (complexidade && p.complexidade_cod !== complexidade) return false;
    if (sexo && p.sexo_cod !== sexo) return false;
    if (registro && !p.registros.includes(registro)) return false;
    if (onlyPaid && p.vl_sa <= 0 && p.vl_sh <= 0 && p.vl_sp <= 0) return false;
    if (onlyObrig && !(p.qt_obrig > 0)) return false;

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
        <td colspan="5" class="empty-state">
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
              ${regBadges}${extraReg}${obrigBadge}${compatBadge}
            </div>
          </td>
          <td>
            <div>${escapeHtml(formatAgeRange(p.idade_min, p.idade_max))}</div>
            <div class="proc-sub">Sexo: ${escapeHtml(p.sexo)}</div>
          </td>
          <td>
            ${getCpfBadge(p)}
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

const COMPAT_GROUPS = [
  { tipo: "5", label: "Secundários / Especiais Obrigatórios", cls: "badge-danger" },
  { tipo: "1", label: "Compatíveis / Opcionais", cls: "badge-info" },
  { tipo: "3", label: "Concomitantes", cls: "badge-ok" },
  { tipo: "4", label: "Sequenciais", cls: "badge-neutral" },
  { tipo: "2", label: "Incompatíveis / Excludentes", cls: "badge-warn" },
];

function renderCompatSection(items) {
  if (!items || items.length === 0) {
    return '<span class="proc-sub">Nenhuma regra de compatibilidade vinculada a este procedimento como principal.</span>';
  }

  return COMPAT_GROUPS.map((grp) => {
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
    </div>

    <div class="section-title">Classificação</div>
    <p style="margin:0.2rem 0 0.6rem;font-size:0.88rem;">
      <strong>Grupo:</strong> ${escapeHtml(proc.grupo)}<br>
      <strong>Subgrupo:</strong> ${escapeHtml(proc.subgrupo)}<br>
      <strong>Forma de Organização:</strong> ${escapeHtml(proc.forma || "—")}
    </p>

    <div class="section-title">Instrumentos de Registro</div>
    <div class="badges-row">${registrosHtml}</div>

    <div class="section-title">Modalidades de Atendimento</div>
    <div class="badges-row">${modalidadesHtml}</div>

    <div class="section-title">Atributos / Detalhes SIGTAP</div>
    <div class="badges-row">${detalhesHtml}</div>

    <div class="section-title">Compatibilidades / Secundários (Obrigatórios e Opcionais)</div>
    <div id="modal-compat" class="proc-sub">Carregando compatibilidades...</div>

    <div class="section-title">Descrição Oficial</div>
    <div id="modal-desc" class="desc-text">Carregando descrição...</div>
  `;

  try {
    const [descs, compats] = await Promise.all([
      loadDescriptions(),
      loadCompatibilidades(),
    ]);
    const compatEl = document.getElementById("modal-compat");
    if (compatEl) {
      compatEl.innerHTML = renderCompatSection(compats[codigo] || []);
    }
    const descEl = document.getElementById("modal-desc");
    if (descEl) {
      descEl.textContent = descs[codigo] || "Sem descrição cadastrada no SIGTAP.";
    }
  } catch {
    const compatEl = document.getElementById("modal-compat");
    if (compatEl) compatEl.textContent = "Não foi possível carregar as compatibilidades.";
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
    "Complexidade",
    "Sexo",
    "Idade_Min_Meses",
    "Idade_Max_Meses",
    "CPF_CNS",
    "Valor_SA",
    "Valor_SH",
    "Valor_SP",
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
        p.complexidade,
        p.sexo,
        p.idade_min ?? "",
        p.idade_max ?? "",
        p.cpf_label,
        p.vl_sa.toFixed(2).replace(".", ","),
        p.vl_sh.toFixed(2).replace(".", ","),
        p.vl_sp.toFixed(2).replace(".", ","),
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
    applyFilters();
  });

  for (const el of [
    els.subgroupFilter,
    els.cpfFilter,
    els.complexityFilter,
    els.sexFilter,
    els.registroFilter,
    els.paidOnly,
    els.obrigOnly,
  ]) {
    el.addEventListener("change", applyFilters);
  }

  els.clearBtn.addEventListener("click", () => {
    els.searchInput.value = "";
    els.groupFilter.value = "";
    populateSubgroupFilter("");
    els.subgroupFilter.value = "";
    els.cpfFilter.value = "";
    els.complexityFilter.value = "";
    els.sexFilter.value = "";
    els.registroFilter.value = "";
    els.paidOnly.checked = false;
    els.obrigOnly.checked = false;
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
        <td colspan="5" class="empty-state">
          Falha ao carregar os dados: ${escapeHtml(err.message)}
        </td>
      </tr>
    `;
  }
}

init();
