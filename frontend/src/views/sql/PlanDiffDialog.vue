<template>
  <el-dialog :model-value="modelValue" title="执行计划 · 访问路径对比" width="80%" top="5vh" destroy-on-close @update:model-value="$emit('update:modelValue', $event)">
    <div v-loading="loading">
      <el-alert :type="alertType" :closable="false" show-icon :title="data.summary || '无对比结果'" style="margin-bottom: 10px" />
      <el-row :gutter="12" v-if="data.parsed">
        <el-col :span="12">
          <div class="card-title">旧计划访问路径</div>
          <div v-for="(x, i) in data.oldAccess || []" :key="'o' + i" class="path" :class="{ gone: (data.removed || []).includes(x) }">{{ x }}</div>
          <div class="join">连接：{{ (data.oldJoins || []).join('、') || '-' }}</div>
        </el-col>
        <el-col :span="12">
          <div class="card-title">新计划访问路径</div>
          <div v-for="(x, i) in data.newAccess || []" :key="'n' + i" class="path" :class="{ added: (data.added || []).includes(x) }">{{ x }}</div>
          <div class="join">连接：{{ (data.newJoins || []).join('、') || '-' }}</div>
        </el-col>
      </el-row>
      <el-row :gutter="12" style="margin-top: 10px">
        <el-col :span="12">
          <div class="card-title">旧计划原文 <el-tag v-if="oldSrc" size="small" type="info">{{ oldSrc }}</el-tag></div>
          <pre class="plan">{{ oldText || '（无）' }}</pre>
        </el-col>
        <el-col :span="12">
          <div class="card-title">新计划原文 <el-tag v-if="newSrc" size="small" type="info">{{ newSrc }}</el-tag></div>
          <pre class="plan">{{ newText || '（无）' }}</pre>
        </el-col>
      </el-row>
    </div>
  </el-dialog>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  modelValue: Boolean,
  loading: Boolean,
  data: { type: Object, default: () => ({}) },
})
defineEmits(['update:modelValue'])
const oldText = computed(() => props.data.oldPlan ?? props.data.beforePlan)
const newText = computed(() => props.data.newPlan ?? props.data.afterPlan)
const oldSrc = computed(() => props.data.oldSource ?? props.data.beforeSource)
const newSrc = computed(() => props.data.newSource ?? props.data.afterSource)
const alertType = computed(() => {
  if (!props.data.parsed) return 'warning'
  if (!props.data.oldFullScan && props.data.newFullScan) return 'error'
  return props.data.changed ? 'info' : 'success'
})
</script>

<style scoped>
.path { font-family: Consolas, Menlo, monospace; font-size: 12px; padding: 2px 6px; border-radius: 3px; margin-bottom: 2px; background: var(--el-fill-color-light, #f5f7fa); }
.path.gone { background: #fde2e2; text-decoration: line-through; }
.path.added { background: #e1f3d8; }
.join { font-size: 12px; color: #909399; margin-top: 4px; }
.plan { background: var(--el-fill-color-light, #f5f7fa); padding: 8px; max-height: 340px; overflow: auto; font-size: 11px; line-height: 1.35; white-space: pre; }
</style>
