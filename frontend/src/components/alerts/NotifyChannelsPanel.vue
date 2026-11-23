<template>
  <div style="max-height:320px;overflow-y:auto">
    <p style="font-size:11px;color:#909399;margin:0 0 8px">开关见「系统配置 → 通知外发」；送达状态见告警详情。</p>
    <div v-if="canMutate" style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">
      <el-button size="small" type="primary" @click="openChannel()">新建</el-button>
      <el-button size="small" :loading="running" @click="runOnce">立即外发</el-button>
      <el-button size="small" @click="loadChannels">刷新</el-button>
    </div>
    <div v-else style="margin-bottom:8px">
      <el-button size="small" @click="loadChannels">刷新</el-button>
    </div>
    <el-table :data="channels" size="small" stripe v-loading="loadingCh" max-height="220">
      <el-table-column prop="CHANNEL_NAME" label="名称" min-width="90" show-overflow-tooltip />
      <el-table-column prop="MIN_SEVERITY" label="级别" width="48" />
      <el-table-column label="启用" width="48">
        <template #default="{ row }">
          <el-tag :type="row.ENABLED == 1 ? 'success' : 'info'" size="small">{{ row.ENABLED == 1 ? '是' : '否' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column v-if="canMutate" label="操作" width="100" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openChannel(row)">编辑</el-button>
          <el-button link size="small" :loading="testingId === row.CHANNEL_ID" @click="testChannel(row.CHANNEL_ID)">测</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="chDialog" :title="chForm.channelId ? '编辑 Webhook' : '新建 Webhook'" width="480px" append-to-body>
      <el-form :model="chForm" label-width="90px" size="small">
        <el-form-item label="名称"><el-input v-model="chForm.channelName" /></el-form-item>
        <el-form-item label="URL"><el-input v-model="chForm.endpointUrl" placeholder="https://..." /></el-form-item>
        <el-form-item label="Token 头"><el-input v-model="chForm.secretHeader" /></el-form-item>
        <el-form-item label="Token"><el-input v-model="chForm.secretToken" type="password" show-password /></el-form-item>
        <el-form-item label="最低级别">
          <el-select v-model="chForm.minSeverity" style="width:100px">
            <el-option label="P1" value="P1" /><el-option label="P2" value="P2" /><el-option label="P3" value="P3" />
          </el-select>
        </el-form-item>
        <el-form-item label="启用"><el-switch v-model="chForm.enabled" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="chDialog = false">取消</el-button>
        <el-button type="primary" :loading="savingCh" @click="saveChannel">保存</el-button>
        <el-button v-if="chForm.channelId" type="danger" link @click="removeChannel(chForm.channelId)">删除</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { useAuthStore } from '@/stores/auth.js'
import { ElMessage, ElMessageBox } from 'element-plus'
import { platformApi } from '@/api/index.js'

const auth = useAuthStore()
const canMutate = computed(() => ['ADMIN', 'DBA', 'OPS'].includes(auth.user?.role))

const channels = ref([])
const loadingCh = ref(false)
const running = ref(false)
const savingCh = ref(false)
const testingId = ref(null)
const chDialog = ref(false)
const chForm = reactive({
  channelId: null, channelName: '', channelType: 'WEBHOOK', endpointUrl: '',
  secretHeader: 'X-Webhook-Token', secretToken: '', minSeverity: 'P2', enabled: true,
})

async function loadChannels() {
  loadingCh.value = true
  try { channels.value = (await platformApi.notify.channels()).data || [] }
  catch (e) { ElMessage.error(e.message || '加载失败') }
  finally { loadingCh.value = false }
}

function openChannel(row) {
  if (row) {
    Object.assign(chForm, {
      channelId: row.CHANNEL_ID, channelName: row.CHANNEL_NAME, channelType: 'WEBHOOK',
      endpointUrl: row.ENDPOINT_URL || '', secretHeader: row.SECRET_HEADER || 'X-Webhook-Token',
      secretToken: row.SECRET_TOKEN || '', minSeverity: row.MIN_SEVERITY || 'P2', enabled: row.ENABLED == 1,
    })
  } else {
    Object.assign(chForm, {
      channelId: null, channelName: '', channelType: 'WEBHOOK', endpointUrl: '',
      secretHeader: 'X-Webhook-Token', secretToken: '', minSeverity: 'P2', enabled: true,
    })
  }
  chDialog.value = true
}

async function saveChannel() {
  savingCh.value = true
  try {
    const body = { ...chForm }
    if (chForm.channelId) await platformApi.notify.updateChannel(chForm.channelId, body)
    else await platformApi.notify.createChannel(body)
    ElMessage.success('已保存')
    chDialog.value = false
    await loadChannels()
  } catch (e) { ElMessage.error(e.message) }
  finally { savingCh.value = false }
}

async function testChannel(id) {
  testingId.value = id
  try {
    await platformApi.notify.testChannel(id)
    ElMessage.success('测试已发送')
  } catch (e) { ElMessage.error(e.message) }
  finally { testingId.value = null }
}

async function removeChannel(id) {
  try {
    await ElMessageBox.confirm('确定删除该渠道？', '确认')
    await platformApi.notify.deleteChannel(id)
    ElMessage.success('已删除')
    chDialog.value = false
    loadChannels()
  } catch { /* cancel */ }
}

async function runOnce() {
  running.value = true
  try {
    const r = await platformApi.notify.runNotifyOnce()
    ElMessage.success(`入队 ${r.data?.enqueued ?? 0}，发送 ${r.data?.sent ?? 0}`)
  } catch (e) { ElMessage.error(e.message) }
  finally { running.value = false }
}

function load() {
  return loadChannels()
}

defineExpose({ load })
</script>
