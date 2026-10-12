<script setup lang="ts">
import {
  CandlestickSeries,
  ColorType,
  createChart,
  LineStyle,
  type AutoscaleInfo,
  type IChartApi,
  type IPriceLine,
  type PriceLineOptions,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { onBeforeUnmount, onMounted, useTemplateRef, watch, watchEffect } from 'vue';
import { pxDecimals } from '../hl/format';
import type { Candle } from '../hl/marketData';
import { useTerminalStore, type Leg } from '../stores/terminal';
import { lineLabels } from './format';

const HIT_PX = 6;

const store = useTerminalStore();
const container = useTemplateRef<HTMLDivElement>('container');

let chart: IChartApi | undefined;
let series: ISeriesApi<'Candlestick'> | undefined;
let lines: Record<Leg | 'ioc', IPriceLine> | undefined;
let dragging: Leg | undefined;

const toBar = (c: Candle) => ({
  time: (c.timeMs / 1000) as UTCTimestamp,
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
});

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function legAt(y: number): Leg | undefined {
  if (!series || !lines) return undefined;
  let best: { leg: Leg; distance: number } | undefined;
  for (const leg of ['entry', 'stop', 'tp'] as const) {
    const lineY = series.priceToCoordinate(lines[leg].options().price);
    if (lineY === null) continue;
    const distance = Math.abs(lineY - y);
    if (distance <= HIT_PX && (!best || distance < best.distance)) best = { leg, distance };
  }
  return best?.leg;
}

const localY = (event: PointerEvent) =>
  event.clientY - (container.value?.getBoundingClientRect().top ?? 0);

// The chart pans on mousedown, which fires after pointerdown: turning scroll and scale off
// here is enough to keep the canvas still while a line is dragged. Autoscale is frozen too,
// or the axis would rescale under the cursor as the line nears the edge.
function onPointerDown(event: PointerEvent) {
  const leg = legAt(localY(event));
  if (!leg || !chart || !container.value) return;
  dragging = leg;
  container.value.setPointerCapture(event.pointerId);
  chart.applyOptions({ handleScroll: false, handleScale: false });
  chart.priceScale('right').applyOptions({ autoScale: false });
}

function onPointerMove(event: PointerEvent) {
  const y = localY(event);
  if (!container.value || !series) return;
  if (!dragging) {
    const cursor = legAt(y) ? 'ns-resize' : '';
    if (container.value.style.cursor !== cursor) container.value.style.cursor = cursor;
    return;
  }
  const price = series.coordinateToPrice(y);
  if (price !== null) store.moveLine(dragging, price);
}

function onPointerUp() {
  if (!dragging) return;
  dragging = undefined;
  chart?.applyOptions({ handleScroll: true, handleScale: true });
  chart?.priceScale('right').applyOptions({ autoScale: true });
}

function createLines(candles: ISeriesApi<'Candlestick'>) {
  const entryColor = token('--entry');
  const line = (color: string, options: Partial<PriceLineOptions> = {}) =>
    candles.createPriceLine({
      price: 0,
      color,
      lineWidth: 1,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      ...options,
    });
  return {
    entry: line(entryColor),
    stop: line(token('--short')),
    tp: line(token('--long')),
    ioc: line(entryColor, {
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: false,
      title: 'IOC limit',
    }),
  };
}

function watchCandles(candles: ISeriesApi<'Candlestick'>) {
  let lastBarMs = 0;
  watch(
    () => store.candles,
    (history) => {
      const lastClose = history.at(-1)?.close;
      const spec = store.instrument;
      if (lastClose && spec) {
        const precision = pxDecimals(lastClose, spec.szDecimals);
        candles.applyOptions({
          priceFormat: { type: 'price', precision, minMove: 10 ** -precision },
        });
      }
      lastBarMs = history.at(-1)?.timeMs ?? 0;
      candles.setData(history.map(toBar));
    },
    { immediate: true },
  );
  watch(
    () => store.lastCandle,
    (candle) => {
      // The chart rejects a bar older than its last one, e.g. a late push or a replay
      // after a reconnect.
      if (!candle || candle.timeMs < lastBarMs) return;
      lastBarMs = candle.timeMs;
      candles.update(toBar(candle));
    },
  );
}

// Keep the stop and take-profit on screen: they are often outside the candle range.
function withLines(original: () => AutoscaleInfo | null): AutoscaleInfo | null {
  const info = original();
  if (!info?.priceRange) return info;
  const { minValue, maxValue } = info.priceRange;
  const prices = [store.stopPx, store.tpPx, store.expectedEntryPx].filter((px) => px > 0);
  return {
    ...info,
    priceRange: {
      minValue: Math.min(minValue, ...prices),
      maxValue: Math.max(maxValue, ...prices),
    },
  };
}

onMounted(() => {
  if (!container.value) return;
  const rule = token('--rule');
  chart = createChart(container.value, {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: token('--bg') },
      textColor: token('--muted'),
      fontFamily: token('--font-mono'),
      fontSize: 11,
      attributionLogo: true,
    },
    grid: { vertLines: { color: rule }, horzLines: { color: rule } },
    rightPriceScale: { borderColor: rule },
    timeScale: { borderColor: rule, timeVisible: true },
  });
  const long = token('--long');
  const short = token('--short');
  const candles = chart.addSeries(CandlestickSeries, {
    upColor: long,
    downColor: short,
    borderVisible: false,
    wickUpColor: long,
    wickDownColor: short,
    priceLineVisible: false,
    lastValueVisible: false,
    autoscaleInfoProvider: withLines,
  });
  series = candles;
  lines = createLines(candles);
  chart.subscribeCrosshairMove((param) => {
    store.cursorPx = param.point
      ? (candles.coordinateToPrice(param.point.y) ?? undefined)
      : undefined;
  });
  watchCandles(candles);
  watchEffect(updateLines);
});

onBeforeUnmount(() => {
  chart?.remove();
});

function updateLines() {
  if (!lines) return;
  const sizing = store.okSizing;
  const labels = sizing && lineLabels(sizing, store.markPx, store.coin);
  const isMarket = store.entryKind === 'market';
  lines.entry.applyOptions({
    price: sizing?.expectedEntryPx ?? store.expectedEntryPx,
    lineStyle: isMarket ? LineStyle.Dashed : LineStyle.Solid,
    title: labels?.entry ?? '',
  });
  lines.ioc.applyOptions({
    price: sizing?.entryPx ?? store.expectedEntryPx,
    lineVisible: isMarket,
  });
  lines.stop.applyOptions({ price: sizing?.stopPx ?? store.stopPx, title: labels?.stop ?? '' });
  lines.tp.applyOptions({ price: sizing?.tpPx ?? store.tpPx, title: labels?.tp ?? '' });
}
</script>
<template>
  <div
    ref="container"
    class="chart"
    data-testid="chart"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  />
</template>

<style scoped>
.chart {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
}
</style>
