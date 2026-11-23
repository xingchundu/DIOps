<template>
  <div class="page-container">
  <!-- 修改者: dxc | 时间: 2026-11-12 | 平台 SYS_AUDIT_LOG 合规视图 -->
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:16px;font-weight:600">操作审计</span>
        <el-button size="small" icon="Refresh" :loading="loading" @click="load(1)">刷新</el-button>
      </div>
      <p class="text-gray" style="font-size:12px;margin-top:6px">数据来自 SYS_AUDIT_LOG（登录、配置变更、阶段1外发等）。仅管理员可查看。</p>
    </div>
    <div class="card">
      <div class="filters" style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap">
        <el-input v-model="fq.userId" placeholder="用户ID" clearable style="width:120px" @keyup.enter="load(1)" />
        <el-input v-model="fq.action" placeholder="动作 ACTION" clearable style="width:180px" @keyup.enter="load(1)" />
        <el-button type="primary" size="small" @click="load(1)">查询</el-button>
      </div>
      <el-table :data="rows" stripe border size="small" v-loading="loading" max-height="560">
        <el-table-column prop="CREATED_AT" label="时间" width="165">
          <template #default="{ row }">{{ fmt(row.CREATED_AT) }}</template>
        </el-table-column>
        <el-table-column prop="USERNAME" label="用户" width="110" />
        <el-table-column prop="ACTION" label="动作" width="160" show-overflow-tooltip />
        <el-table-column prop="RESOURCE" label="资源" width="140" show-overflow-tooltip />
        <el-table-column prop="RESOURCE_ID" label="资源ID" width="90" />
        <el-table-column prop="IP_ADDR" label="IP" width="120" />
        <el-table-column prop="STATUS" label="状态" width="80" />
        <el-table-column prop="DETAIL" label="详情" min-width="200" show-overflow-tooltip />
      </el-table>
      <el-pagination class="pager" small layout="total, prev, pager, next" :total="total"
                     v-model:current-page="page" :page-size="pageSize" @current-change="load" />
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { userApi } from '@/api/index.js'

const loading = ref(false)
const rows = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = 20
const fq = reactive({ userId: '', action: '' })

function fmt(v) {
  if (!v) return '-'
  return String(v).replace('T', ' ').slice(0, 19)
}

async function load(p) {
  if (typeof p === 'number') page.value = p
  loading.value = true
  try {
    const r = await userApi.audit({
      page: page.value,
      size: pageSize,
      userId: fq.userId || undefined,
      action: fq.action || undefined,
    })
    const data = r.data || {}
    rows.value = data.list || data.rows || []
    total.value = data.total ?? rows.value.length
  } catch (e) {
    ElMessage.error(e.message || '加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => load(1))
</script>

<style scoped>
.text-gray { color: #909399; }
.pager { margin-top: 12px; justify-content: flex-end; }
</style>
