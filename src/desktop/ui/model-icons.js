// Catalogo padrao de modelos Gemini exibido antes do app carregar a config salva.
// Espelha DEFAULT_MODEL_CATALOG em src/config.ts. Cada item vira um card no modal
// "Selecionar modelo" (toggle de redirecionamento + botao de teste).
window.agentBridgeModels = [
  { key: 'flash', label: 'Gemini 3.8 Flash', model: 'gemini-3.8-flash' },
  { key: 'pro', label: 'Gemini 3.1 Pro (preview)', model: 'gemini-3.1-pro-preview' },
  { key: 'flash', label: 'Gemini 3.7 Flash', model: 'gemini-3.7-flash' },
  { key: 'flash', label: 'Gemini 3.6 Flash', model: 'gemini-3.6-flash' },
  { key: 'flash', label: 'Gemini 3.5 Flash', model: 'gemini-3.5-flash' },
  { key: 'lite', label: 'Gemini 3.5 Flash-Lite', model: 'gemini-3.5-flash-lite' },
  { key: 'lite', label: 'Gemini 3.1 Flash-Lite', model: 'gemini-3.1-flash-lite' }
];

// Icones genericos por familia (nao sao logos oficiais): raio = Flash,
// diamante = Pro, pena = Flash-Lite.
window.agentBridgeModelIcons = {
  flash: `<svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect x="10" y="10" width="100" height="100" rx="22" fill="#1b2a4a"/>
<path d="M66 22 36 66h20l-6 32 34-46H63l3-30Z" fill="#6f9dff"/>
</svg>`,
  pro: `<svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect x="10" y="10" width="100" height="100" rx="22" fill="#2a2150"/>
<path d="M60 26 90 56 60 94 30 56 60 26Z" fill="#9d8cff"/>
<path d="M60 26 72 56 60 94 48 56 60 26Z" fill="#c9bfff"/>
</svg>`,
  lite: `<svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect x="10" y="10" width="100" height="100" rx="22" fill="#15373a"/>
<path d="M88 30C58 32 38 52 36 86l10-10h16c12-8 22-26 26-46Z" fill="#5fd4c4"/>
<path d="M34 92 70 52" stroke="#15373a" stroke-width="4" stroke-linecap="round"/>
</svg>`
};

// Desenha o icone de um modelo dentro de `element`. Se `iconKey` casar com um SVG
// embutido (flash, pro, lite), usa esse SVG. Caso contrario
// (modelos adicionados pelo usuario, sem icone), desenha um placeholder com a
// primeira letra do nome -- assim nao e preciso criar um SVG novo para cada modelo.
window.agentBridgeModelIcons.renderInto = (element, iconKey, label) => {
  const svg = iconKey ? window.agentBridgeModelIcons[iconKey] : '';
  if (typeof svg === 'string' && svg.trim()) {
    element.innerHTML = svg;
    return;
  }
  const source = String(label || iconKey || '?').trim();
  const letter = (source ? source[0] : '?').toUpperCase();
  const placeholder = document.createElement('span');
  placeholder.className = 'model-icon-letter';
  placeholder.textContent = letter;
  element.replaceChildren(placeholder);
};
