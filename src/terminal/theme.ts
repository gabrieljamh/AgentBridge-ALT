// Camada de estilo da TUI: cores truecolor (24-bit) na mesma paleta do app
// desktop e helpers para desenhar caixas e medir largura ignorando os codigos
// ANSI. Nada aqui escreve no terminal -- so produz strings ja estilizadas.

const ESC = '\x1b[';

// Liga/desliga cor: respeita NO_COLOR e terminais sem TTY.
const COLOR_ENABLED =
  !process.env.NO_COLOR && (process.stdout.isTTY ?? false);

function rgb(r: number, g: number, b: number) {
  return (text: string) =>
    COLOR_ENABLED ? `${ESC}38;2;${r};${g};${b}m${text}${ESC}39m` : text;
}
function bgRgb(r: number, g: number, b: number) {
  return (text: string) =>
    COLOR_ENABLED ? `${ESC}48;2;${r};${g};${b}m${text}${ESC}49m` : text;
}
function style(code: number, reset: number) {
  return (text: string) =>
    COLOR_ENABLED ? `${ESC}${code}m${text}${ESC}${reset}m` : text;
}

// Paleta AgentBridge ALT (espelha styles.css do desktop).
export const c = {
  accent: rgb(91, 140, 255), // #5b8cff azul ALT
  accentStrong: rgb(122, 162, 255), // #7aa2ff
  green: rgb(67, 212, 158), // #43d49e
  red: rgb(255, 107, 122), // #ff6b7a
  amber: rgb(242, 185, 93), // #f2b95d
  text: rgb(242, 244, 248), // #f2f4f8
  muted: rgb(142, 152, 168), // #8e98a8
  faint: rgb(95, 105, 120),
  white: rgb(255, 255, 255),
  bgAccent: bgRgb(91, 140, 255),
  bgPanel: bgRgb(23, 27, 36),
  bold: style(1, 22),
  dim: style(2, 22),
  italic: style(3, 23),
  underline: style(4, 24),
  invert: style(7, 27)
};

// Controle de tela / cursor.
export const screen = {
  clear: `${ESC}2J${ESC}3J${ESC}H`,
  home: `${ESC}H`,
  hideCursor: `${ESC}?25l`,
  showCursor: `${ESC}?25h`,
  eraseLine: `${ESC}2K`,
  altOn: `${ESC}?1049h`,
  altOff: `${ESC}?1049l`
};

// Largura visivel de uma string, descontando sequencias ANSI (\x1b[...m).
const ANSI_RE = /\x1b\[[0-9;]*m/g;
export function visibleLength(text: string): number {
  return text.replace(ANSI_RE, '').length;
}
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

// Trunca preservando os codigos ANSI quando possivel (corta apenas o texto visivel).
export function truncate(text: string, max: number): string {
  if (visibleLength(text) <= max) return text;
  // Caminho simples: sem ANSI, corta direto com reticencias.
  if (!ANSI_RE.test(text)) {
    return max <= 1 ? text.slice(0, max) : text.slice(0, max - 1) + '…';
  }
  // Com ANSI: corta sobre o texto puro e devolve sem estilo (seguro e raro).
  const plain = stripAnsi(text);
  return plain.slice(0, Math.max(0, max - 1)) + '…';
}

export function padEndVisible(text: string, width: number): string {
  const len = visibleLength(text);
  return len >= width ? text : text + ' '.repeat(width - len);
}
export function padStartVisible(text: string, width: number): string {
  const len = visibleLength(text);
  return len >= width ? text : ' '.repeat(width - len) + text;
}
export function centerVisible(text: string, width: number): string {
  const len = visibleLength(text);
  if (len >= width) return text;
  const left = Math.floor((width - len) / 2);
  const right = width - len - left;
  return ' '.repeat(left) + text + ' '.repeat(right);
}

type BoxChars = {
  tl: string; tr: string; bl: string; br: string;
  h: string; v: string; ml: string; mr: string;
};
const ROUND: BoxChars = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', ml: '├', mr: '┤' };

// Desenha uma caixa arredondada com titulo opcional. `lines` ja vem com o
// conteudo (pode ter ANSI). innerWidth e a largura util interna (sem as bordas).
export function box(options: {
  title?: string;
  lines: string[];
  innerWidth: number;
  color?: (text: string) => string;
  titleColor?: (text: string) => string;
}): string[] {
  const { tl, tr, bl, br, h, v } = ROUND;
  const paint = options.color || ((t: string) => t);
  const titlePaint = options.titleColor || c.accent;
  const w = options.innerWidth;
  const out: string[] = [];

  if (options.title) {
    const title = ` ${options.title} `;
    const titleLen = visibleLength(title);
    const dashes = Math.max(0, w - titleLen);
    const left = 1;
    const right = Math.max(0, dashes - left);
    out.push(
      paint(tl + h.repeat(left)) +
      titlePaint(title) +
      paint(h.repeat(right) + tr)
    );
  } else {
    out.push(paint(tl + h.repeat(w) + tr));
  }

  for (const line of options.lines) {
    out.push(paint(v) + ' ' + padEndVisible(truncate(line, w - 2), w - 2) + ' ' + paint(v));
  }
  out.push(paint(bl + h.repeat(w) + br));
  return out;
}

// Separador horizontal interno de uma caixa (├────┤), util entre secoes.
export function boxDivider(innerWidth: number, color?: (t: string) => string): string {
  const paint = color || ((t: string) => t);
  return paint(ROUND.ml + ROUND.h.repeat(innerWidth) + ROUND.mr);
}

// Badge de status colorido (Online / Offline / etc.) com bolinha.
export function statusBadge(state: string): string {
  const dot = '●';
  switch (state) {
    case 'running':
      return c.green(`${dot} Online`);
    case 'starting':
      return c.amber(`${dot} Iniciando`);
    case 'error':
      return c.red(`${dot} Erro`);
    case 'stopped':
      return c.muted(`${dot} Offline`);
    default:
      return c.faint(`${dot} Bloqueado`);
  }
}

// Pequena barra de proporcao (ex.: uso de RPM) com blocos.
export function bar(value: number, max: number, width: number): string {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const filled = Math.round(ratio * width);
  const color = ratio > 0.85 ? c.red : ratio > 0.6 ? c.amber : c.accent;
  return color('█'.repeat(filled)) + c.faint('░'.repeat(width - filled));
}

// Logo em ASCII art para a tela de abertura.
// Fonte "slant" (figlet) para a palavra AgentBridge -- 6 linhas.
// As larguras visiveis sao normalizadas via padEndVisible para que o
// centerVisible as alinhe perfeitamente. Degrede azul: topo em
// accentStrong, meio em accent, base em accent -- da profundidade.
export function logo(): string[] {
  const a = c.accent;
  const s = c.accentStrong;
  const raw = [
    s('     ___                    __  ____       _     __         '),
    s('    /   | ____ ____  ____  / /_/ __ )_____(_)___/ /___ ____ '),
    a('   / /| |/ __ `/ _ \\/ __ \\/ __/ __  / ___/ / __  / __ `/ _ \\'),
    a('  / ___ / /_/ /  __/ / / / /_/ /_/ / /  / / /_/ / /_/ /  __/'),
    a(' /_/  |_\\__, /\\___/_/ /_/\\__/_____/_/  /_/\\__,_/\\__, /\\___/'),
    c.faint('       /____/                                  /____/        ')
  ];
  const maxLen = Math.max(...raw.map((l) => visibleLength(l)));
  return raw.map((l) => padEndVisible(l, maxLen));
}
