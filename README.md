# Consulta SIGTAP — GitHub Pages Automatizado

Portal estático para consulta rápida da **Tabela Unificada do SIGTAP (DATASUS)** pela equipe, atualizado automaticamente todo mês via **GitHub Actions**.

## O que é exibido
- **Código e nome do procedimento** (busca com ou sem pontuação e sem diferenciar acentos)
- **Valores SUS**: Ambulatorial (`SA`), Hospitalar (`SH`), Profissional (`SP`) e Total Hospitalar (`SH + SP`)
- **Faixa etária** (idade mínima e máxima convertidas de meses para anos/meses) e **Sexo permitido**
- **Exigência de CPF/CNS** (obtida dos detalhes oficiais da SIGTAP: `058 - Obrigatório CPF`, `009 - Exige CPF/CNS`, `034 - Não exige CPF/CNS`)
- **Instrumentos de registro** (`BPA Consolidado`, `BPA Individualizado`, `AIH`, `APAC`, `RAAS`, `e-SUS APS`)
- **Complexidade, financiamento, quantidade máxima, permanência, pontos, detalhes e descrição oficial** (no modal ao clicar em um procedimento)
- **Exportação para CSV** dos resultados filtrados

## Estrutura do projeto
- `scripts/update_sigtap.py`: baixa o pacote mensal mais recente (`TabelaUnificada_*.zip`) do FTP oficial do DATASUS (`ftp2.datasus.gov.br`, com fallback HTTPS caso necessário), lê dinamicamente os arquivos `*_layout.txt` e gera os JSONs em `docs/data/`.
- `docs/`: página estática (`index.html`, `styles.css`, `app.js`) e os dados (`data/procedimentos.json`, `data/descricoes.json`, `data/meta.json`).
- `.github/workflows/atualizar-sigtap.yml`: workflow que verifica atualizações automaticamente nos dias 1, 3, 5, 10 e 15 de cada mês e publica no GitHub Pages.

## Como testar localmente
```bash
python3 -m http.server -d docs 8000
```
Depois acesse `http://localhost:8000` no navegador.

Para atualizar os dados manualmente via terminal (usando apenas a biblioteca padrão do Python):
```bash
python3 scripts/update_sigtap.py --out docs/data
```

## Como publicar no GitHub Pages
1. Suba este repositório para o GitHub na branch `main`.
2. No repositório do GitHub, vá em **Settings → Pages**.
3. Em **Build and deployment → Source**, selecione **GitHub Actions**.
4. Pronto! O workflow fará o deploy automático sempre que houver push na `main`, nas datas agendadas ou quando você clicar em **Run workflow** na aba **Actions**.
