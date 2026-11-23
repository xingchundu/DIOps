<template>
  <svg :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`" class="spark" role="img" :aria-label="label">
    <title>{{ label }}</title>
    <polyline v-if="points" :points="points" fill="none" :stroke="color" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
    <circle v-if="last" :cx="last[0]" :cy="last[1]" r="2.5" :fill="color" />
    <text v-if="!points" :x="width / 2" :y="height / 2 + 4" text-anchor="middle" class="empty">无走势数据</text>
  </svg>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  values: { type: Array, default: () => [] },
  width: { type: Number, default: 120 },
  height: { type: Number, default: 28 },
  color: { type: String, default: '#2a78d6' },
  max: { type: Number, default: null },
  label: { type: String, default: '' },
})

const coords = computed(() => {
  const vals = props.values.map(v => (v == null || v === '' ? null : Number(v)))
  const nums = vals.filter(v => v != null && !isNaN(v))
  if (nums.length < 2) return null
  const hi = props.max ?? Math.max(...nums)
  const lo = props.max != null ? 0 : Math.min(...nums)
  const span = hi - lo || 1
  const pad = 3
  const step = (props.width - pad * 2) / (vals.length - 1)
  const out = []
  vals.forEach((v, i) => {
    if (v == null || isNaN(v)) return
    out.push([pad + i * step, props.height - pad - ((v - lo) / span) * (props.height - pad * 2)])
  })
  return out.length >= 2 ? out : null
})
const points = computed(() => coords.value?.map(p => p.map(n => n.toFixed(1)).join(',')).join(' '))
const last = computed(() => coords.value?.[coords.value.length - 1])
</script>

<style scoped>
.spark { display: block; }
.empty { font-size: 10px; fill: #bfbfbf; }
</style>
