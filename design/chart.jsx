// chart.jsx — Candle chart + volume histogram (SVG, no deps)
// Intended size: fills its parent; pass width/height in props.

function Chart({ candles, width = 760, height = 360, up, down, text3, border, borderSoft }) {
  const pad = { l: 56, r: 56, t: 10, b: 48 };
  const volH = 62;
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b - volH;
  const n = candles.length;
  const cw = innerW / n;

  const hi = Math.max(...candles.map(c => c.high));
  const lo = Math.min(...candles.map(c => c.low));
  const range = hi - lo;
  const y = (v) => pad.t + (1 - (v - lo) / range) * innerH;

  const vmax = Math.max(...candles.map(c => c.vol));
  const vy = (v) => pad.t + innerH + (volH - (v / vmax) * (volH - 8));

  // grid prices (5 lines)
  const gridPrices = [];
  for (let i = 0; i < 5; i++) {
    gridPrices.push(lo + (range * i) / 4);
  }

  const last = candles[candles.length - 1];
  const lastY = y(last.close);
  const lastColor = last.close >= last.open ? up : down;

  const fmtAxis = (v) => {
    if (v > 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v > 1e3) return Math.round(v).toLocaleString('en-US');
    return v.toFixed(0);
  };

  // time labels (every ~12 candles)
  const timeLabels = [];
  for (let i = 0; i < n; i += 16) {
    const hh = String(9 + Math.floor(i / 4)).padStart(2, '0');
    const mm = String((i % 4) * 15).padStart(2, '0');
    timeLabels.push({ x: pad.l + cw * (i + 0.5), label: `${hh}:${mm}` });
  }

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      {/* horizontal grid + y-axis price labels */}
      {gridPrices.map((p, i) => (
        <g key={i}>
          <line x1={pad.l} x2={width - pad.r} y1={y(p)} y2={y(p)} stroke={borderSoft} strokeWidth={1} />
          <text x={width - pad.r + 6} y={y(p) + 3.5} fill={text3} fontSize={10} fontFamily="var(--font-num)">
            {fmtAxis(p)}
          </text>
        </g>
      ))}
      {/* volume baseline */}
      <line x1={pad.l} x2={width - pad.r} y1={pad.t + innerH + volH} y2={pad.t + innerH + volH} stroke={border} />

      {/* candles */}
      {candles.map((c, i) => {
        const x = pad.l + cw * (i + 0.5);
        const col = c.close >= c.open ? up : down;
        const bodyTop = y(Math.max(c.open, c.close));
        const bodyBot = y(Math.min(c.open, c.close));
        const bw = Math.max(2, cw * 0.62);
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={y(c.high)} y2={y(c.low)} stroke={col} strokeWidth={1} />
            <rect x={x - bw / 2} y={bodyTop} width={bw} height={Math.max(1, bodyBot - bodyTop)} fill={col} />
            <rect x={x - bw / 2} y={vy(c.vol)} width={bw} height={pad.t + innerH + volH - vy(c.vol)} fill={col} opacity={0.35} />
          </g>
        );
      })}

      {/* time labels */}
      {timeLabels.map((t, i) => (
        <text key={i} x={t.x} y={height - 28} fill={text3} fontSize={10} fontFamily="var(--font-num)" textAnchor="middle">
          {t.label}
        </text>
      ))}
      <text x={pad.l - 8} y={pad.t + innerH + volH / 2 + 3} fill={text3} fontSize={10} fontFamily="var(--font-num)" textAnchor="end">VOL</text>

      {/* last price marker */}
      <line x1={pad.l} x2={width - pad.r} y1={lastY} y2={lastY} stroke={lastColor} strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />
      <rect x={width - pad.r + 2} y={lastY - 9} width={50} height={18} fill={lastColor} rx={2} />
      <text x={width - pad.r + 27} y={lastY + 4} fill="#fff" fontSize={11} fontFamily="var(--font-num)" fontWeight={600} textAnchor="middle">
        {fmtAxis(last.close)}
      </text>
    </svg>
  );
}

// depth mini-chart for order book area
function DepthMini({ asks, bids, width, height, up, down }) {
  // cumulative qty
  const cumBids = [];
  let sb = 0;
  for (let i = bids.length - 1; i >= 0; i--) { sb += bids[i].qty; cumBids.unshift({ p: bids[i].price, q: sb }); }
  const cumAsks = [];
  let sa = 0;
  for (let i = 0; i < asks.length; i++) { sa += asks[i].qty; cumAsks.push({ p: asks[i].price, q: sa }); }
  const all = [...cumBids, ...cumAsks];
  const pMin = all[0].p;
  const pMax = all[all.length - 1].p;
  const qMax = Math.max(...all.map(x => x.q));
  const x = (p) => ((p - pMin) / (pMax - pMin)) * width;
  const y = (q) => height - (q / qMax) * height;
  const mkPath = (arr) => {
    const first = arr[0];
    let d = `M ${x(first.p)} ${height} L ${x(first.p)} ${y(first.q)}`;
    for (let i = 1; i < arr.length; i++) d += ` L ${x(arr[i].p)} ${y(arr[i].q)}`;
    d += ` L ${x(arr[arr.length - 1].p)} ${height} Z`;
    return d;
  };
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <path d={mkPath(cumBids)} fill={down} fillOpacity={0.14} stroke={down} strokeWidth={1} />
      <path d={mkPath(cumAsks)} fill={up} fillOpacity={0.14} stroke={up} strokeWidth={1} />
    </svg>
  );
}

// tiny sparkline for market list rows
function Sparkline({ seed = 1, width = 76, height = 22, color }) {
  const r = mulberry32(seed);
  const n = 24;
  const pts = [];
  let v = 50;
  for (let i = 0; i < n; i++) { v += (r() - 0.5) * 12; pts.push(v); }
  const max = Math.max(...pts), min = Math.min(...pts);
  const rng = Math.max(1, max - min);
  const d = pts.map((p, i) => {
    const x = (i / (n - 1)) * width;
    const y = height - ((p - min) / rng) * (height - 2) - 1;
    return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <path d={d} stroke={color} strokeWidth={1.2} fill="none" />
    </svg>
  );
}

Object.assign(window, { Chart, DepthMini, Sparkline });
