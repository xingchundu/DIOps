<template>
  <div class="dbi-wrap">
    <el-tabs v-model="tab" type="card" @tab-change="onTab">
      <el-tab-pane label="检查项" name="items" lazy><ItemsTab :meta="meta" /></el-tab-pane>
      <el-tab-pane label="巡检模板" name="templates" lazy><TemplatesTab :meta="meta" /></el-tab-pane>
      <el-tab-pane label="巡检计划" name="plans" lazy><PlansTab :meta="meta" @goto="goto" /></el-tab-pane>
      <el-tab-pane label="巡检记录" name="runs" lazy><RunsTab :meta="meta" :open-run="openRun" @goto="goto" /></el-tab-pane>
      <el-tab-pane label="问题项" name="issues" lazy><IssuesTab :meta="meta" @goto="goto" /></el-tab-pane>
      <el-tab-pane label="巡检报告" name="reports" lazy><ReportsTab @goto="goto" /></el-tab-pane>
    </el-tabs>
  </div>
</template>
<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { dbInspectApi } from '@/api/index.js'
import ItemsTab from './ItemsTab.vue'
import TemplatesTab from './TemplatesTab.vue'
import PlansTab from './PlansTab.vue'
import RunsTab from './RunsTab.vue'
import IssuesTab from './IssuesTab.vue'
import ReportsTab from './ReportsTab.vue'

const route = useRoute(); const router = useRouter()
const tab = ref(['items', 'templates', 'plans', 'runs', 'issues', 'reports'].includes(route.query.tab) ? route.query.tab : 'runs')
const meta = ref({ categories: [], families: [], supportedTypes: [], scope: { dbTypes: [], envs: [], bizLines: [], instances: [] } })
const openRun = ref(route.query.run ? Number(route.query.run) : null)
const onTab = t => router.replace({ query: { ...route.query, tab: t } })
function goto(t, runId) { if (runId) openRun.value = Number(runId); tab.value = t; onTab(t) }
onMounted(async () => { try { meta.value = (await dbInspectApi.meta()).data } catch { /* 已提示 */ } })
</script>
<style scoped>
.dbi-wrap { padding: 4px 2px; }
</style>
