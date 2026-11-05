# Clima Londrina – Instituto Biosimos

Mapa de livre acesso com dados públicos sobre o clima de Londrina: série histórica (temperatura, dias de calor, chuva forte, rajadas e ventos), ilhas de calor e vegetação por satélite, áreas baixas sujeitas a alagamento e registros de impactos climáticos (alagamentos, quedas de árvores, vendavais).

## Como os dados são atualizados
A rotina **Atualizar dados climáticos** (aba Actions) roda todo mês e pode ser disparada manualmente:
- `tools/clima_historico.py` – ERA5 via Open-Meteo (1981 em diante)
- `tools/calor_vegetacao.py` – Landsat 8/9 (USGS), mediana dos verões recentes
- `tools/alagamento_hand.py` – Copernicus DEM GLO-30, modelo HAND
- `tools/geocodificar_impactos.py` – registros de impactos
- `tools/atualizar_resumo.py` – números do topo do painel

## Como incluir um impacto registrado
Acrescente uma linha em `data/impactos/registros_base.csv` (data, tipo, título, local, bairro, descrição, fonte, link). Para localização exata, inclua as colunas `latitude` e `longitude`. Tipos: Alagamento, Queda de árvore, Vendaval, Calor extremo, Granizo, Erosão / deslizamento.

## Território rural
- **Indicadores agroclimáticos** (mesma série ERA5): dias com risco de geada (mínima ≤ 3 °C), maior veranico da safra de verão (out–mar), dias ≥ 35 °C na safra, balanço hídrico anual (chuva − evapotranspiração FAO) e chuvas erosivas (≥ 30 mm).
- **Declividade** (Copernicus DEM, classes Embrapa) – `tools/alagamento_hand.py` gera `data/alagamento/declividade.*`.
- **Uso e cobertura do solo** – MapBiomas 10 m, 2023 (`data/mapbiomas`).
- **Vulnerabilidade das microbacias rurais** – `tools/rural_microbacias.py`: índice 0–100 com relevo ≥ 8% (40%), falta de vegetação nativa (35%) e várzeas até 2 m acima do córrego (25%); classes por terços. Saída em `data/rural/`.
- **ZARC** – `tools/zarc.py` baixa as tábuas de risco do MAPA (todas as safras), guarda as linhas de Londrina em `data/zarc/bruto/` e gera `data/zarc/zarc_londrina.json` (calendário de plantio por cultura, ciclo, solo e nível de manejo + histórico das janelas).
