<template>
  <el-dialog :model-value="modelValue" title="授权信息" width="560px" append-to-body @update:model-value="v => emit('update:modelValue', v)" @open="load">
    <div v-loading="loading">
      <el-alert v-if="status" :title="status.message" :type="alertType" show-icon :closable="false" />
      <el-descriptions :column="1" border size="small" class="desc">
        <el-descriptions-item label="机器码">
          <code class="mc">{{ status?.machineCode || '-' }}</code>
          <el-button v-if="status?.machineCode" link type="primary" size="small" @click="copy(status.machineCode)">复制</el-button>
          <div class="hint">由平台库 DBID 生成；迁移应用服务器不变，更换平台库需重新申请授权</div>
        </el-descriptions-item>
        <el-descriptions-item v-if="info?.customer" label="授权客户">{{ info.customer }}</el-descriptions-item>
        <el-descriptions-item label="授权类型">{{ TYPES[status?.type] || status?.type || '-' }}</el-descriptions-item>
        <el-descriptions-item label="到期时间">
          {{ status?.expiresAt || '-' }}
          <el-tag v-if="status?.daysLeft != null && status.loginAllowed" size="small" :type="status.daysLeft < 15 ? 'warning' : 'success'" style="margin-left: 6px">剩余 {{ status.daysLeft }} 天</el-tag>
        </el-descriptions-item>
        <el-descriptions-item v-if="info" label="纳管实例上限">{{ info.maxInstances ?? '不限' }}</el-descriptions-item>
      </el-descriptions>
      <p class="hint">到期后无法登录；监控采集与告警继续运行 7 天，导入新授权后数据连续。续期授权可提前导入，自动衔接。</p>

      <div class="sub">导入授权文件</div>
      <el-upload :auto-upload="false" :show-file-list="false" accept=".lic,.json,.txt" :on-change="onFile">
        <el-button size="small" icon="Upload">选择 .lic 文件</el-button>
      </el-upload>
      <el-input v-model="content" type="textarea" :rows="5" placeholder="或把授权文件内容粘贴到这里" class="mono" />

      <template v-if="info && (info.history || []).length">
        <div class="sub">授权记录</div>
        <el-table :data="info.history" size="small" max-height="180">
          <el-table-column prop="LICENSE_ID" label="编号" min-width="150" show-overflow-tooltip />
          <el-table-column label="类型" width="70"><template #default="{ row }">{{ TYPES[row.LICENSE_TYPE] || row.LICENSE_TYPE }}</template></el-table-column>
          <el-table-column label="有效期" min-width="190"><template #default="{ row }">{{ d(row.NOT_BEFORE) }} ~ {{ d(row.EXPIRES_AT) }}</template></el-table-column>
          <el-table-column label="导入时间" width="100"><template #default="{ row }">{{ d(row.ACTIVATED_AT) }}</template></el-table-column>
        </el-table>
        <div v-for="r in info.rejected || []" :key="r" class="rejected">无效授权：{{ r }}</div>
      </template>
    </div>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
      <el-button type="primary" :loading="activating" :disabled="!content.trim()" @click="activate">导入授权</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { licenseApi } from '@/api/index.js'

const props = defineProps({ modelValue: Boolean, withInfo: Boolean })
const emit = defineEmits(['update:modelValue', 'activated'])

const TYPES = { MONTH: '月度', YEAR: '年度', TRIAL: '试用', CUSTOM: '自定义' }
const status = ref(null)
const info = ref(null)
const loading = ref(false)
const activating = ref(false)
const content = ref('')

const alertType = computed(() => ({ VALID: 'success', EXPIRING: 'warning' }[status.value?.state] || 'error'))

async function load() {
  loading.value = true
  try {
    status.value = (await licenseApi.status()).data
    if (props.withInfo) {
      try { info.value = (await licenseApi.info()).data } catch { info.value = null }
    }
  } catch (e) {
    status.value = { state: 'UNKNOWN', message: e.message || '无法获取授权状态' }
  } finally {
    loading.value = false
  }
}

function onFile(f) {
  const r = new FileReader()
  r.onload = () => { content.value = String(r.result || '') }
  r.readAsText(f.raw, 'utf-8')
}

async function activate() {
  activating.value = true
  try {
    const r = await licenseApi.activate(content.value)
    ElMessage.success(r.msg || '授权导入成功')
    content.value = ''
    await load()
    emit('activated', r.data)
  } catch (e) {
    ElMessage.error(e.message || '导入失败')
  } finally {
    activating.value = false
  }
}

function d(v) {
  if (!v) return '-'
  const t = new Date(v)
  return isNaN(t) ? String(v).slice(0, 10) : `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}

async function copy(t) {
  try {
    await navigator.clipboard.writeText(t)
    ElMessage.success('已复制')
  } catch {
    ElMessage.warning('请手动复制')
  }
}

defineExpose({ load })
</script>

<style scoped>
.desc { margin: 12px 0 6px; }
.mc { font-size: 15px; letter-spacing: 1px; font-weight: 600; }
.hint { font-size: 12px; color: #909399; line-height: 1.6; margin: 4px 0; }
.sub { font-weight: 600; margin: 14px 0 6px; }
.mono :deep(textarea) { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; margin-top: 8px; }
.rejected { font-size: 12px; color: #f56c6c; margin-top: 4px; }
</style>
