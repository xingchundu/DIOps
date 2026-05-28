<template>
  <div class="layout-wrap">
    <aside class="sidebar" :class="{ collapsed }">
      <div class="sidebar-logo" @click="router.push('/dashboard')">
        <span class="logo-icon">🛡️</span>
        <span v-if="!collapsed" class="logo-text">智能平台</span>
      </div>
      <el-menu
        :default-active="activeMenu"
        :collapse="collapsed"
        background-color="#001529"
        text-color="#ffffffa0"
        active-text-color="#ffffff"
        router
        class="sidebar-menu"
      >
        <el-menu-item v-if="auth.showMenu('/dashboard')" index="/dashboard">
          <el-icon><DataAnalysis /></el-icon><template #title>控制台</template>
        </el-menu-item>
        <el-menu-item v-if="auth.showMenu('/monitor')" index="/monitor">
          <el-icon><Monitor /></el-icon><template #title>监控中心</template>
        </el-menu-item>
        <el-menu-item v-if="auth.showMenu('/monitor/collect-scheduler')" index="/monitor/collect-scheduler">
          <el-icon><Timer /></el-icon><template #title>定时采集观测</template>
        </el-menu-item>
        <el-menu-item v-if="auth.showMenu('/monitor/compare')" index="/monitor/compare">
          <el-icon><TrendCharts /></el-icon><template #title>性能对比</template>
        </el-menu-item>
        <el-menu-item v-if="auth.showMenu('/monitor/custom-metrics')" index="/monitor/custom-metrics">
          <el-icon><DataBoard /></el-icon><template #title>自定义监控项</template>
        </el-menu-item>
        <el-menu-item v-if="auth.showMenu('/alerts')" index="/alerts">
          <el-icon><Bell /></el-icon>
          <template #title>
            告警中心
            <el-badge v-if="openAlerts > 0" :value="openAlerts" class="alert-badge" />
          </template>
        </el-menu-item>
        <el-menu-item v-if="auth.showMenu('/cmdb')" index="/cmdb">
          <el-icon><Grid /></el-icon><template #title>资产管理</template>
        </el-menu-item>
        <el-menu-item v-if="auth.showMenu('/cmdb/hosts')" index="/cmdb/hosts">
          <el-icon><Monitor /></el-icon><template #title>主机管理</template>
        </el-menu-item>
        <el-menu-item v-if="auth.showMenu('/cmdb/clusters')" index="/cmdb/clusters">
          <el-icon><Share /></el-icon><template #title>集群拓扑</template>
        </el-menu-item>
        <el-menu-item v-if="auth.showMenu('/cmdb/app-relation')" index="/cmdb/app-relation">
          <el-icon><Connection /></el-icon><template #title>应用依赖关系</template>
        </el-menu-item>
        <el-menu-item v-if="auth.showMenu('/cmdb/tags')" index="/cmdb/tags">
          <el-icon><PriceTag /></el-icon><template #title>标签管理</template>
        </el-menu-item>
        <el-menu-item v-if="auth.showMenu('/automation')" index="/automation">
          <el-icon><SetUp /></el-icon><template #title>自动化运维</template>
        </el-menu-item>
        <el-menu-item v-if="auth.showMenu('/service-catalog')" index="/service-catalog">
          <el-icon><Tickets /></el-icon><template #title>服务工单</template>
        </el-menu-item>
        <el-menu-item v-if="auth.showMenu('/sql')" index="/sql">
          <el-icon><MagicStick /></el-icon><template #title>SQL优化</template>
        </el-menu-item>
        <el-menu-item v-if="auth.showMenu('/sql-review')" index="/sql-review">
          <el-icon><CopyDocument /></el-icon><template #title>SQL评审</template>
        </el-menu-item>
        <el-menu-item v-if="auth.showMenu('/workbench')" index="/workbench">
          <el-icon><Monitor /></el-icon><template #title>SQL工作台</template>
        </el-menu-item>
        <el-menu-item v-if="auth.showMenu('/reports')" index="/reports">
          <el-icon><Document /></el-icon><template #title>报表中心</template>
        </el-menu-item>
        <el-menu-item v-if="auth.showMenu('/ai')" index="/ai">
          <el-icon><MagicStick /></el-icon><template #title>AI 智能分析</template>
        </el-menu-item>
        <el-sub-menu v-if="settingsMenuVisible" index="settings">
          <template #title>
            <el-icon><Setting /></el-icon><span>系统设置</span>
          </template>
          <el-menu-item v-if="auth.isAdmin && auth.showMenu('/settings/users')" index="/settings/users">用户管理</el-menu-item>
          <el-menu-item v-if="auth.isAdmin && auth.showMenu('/settings/roles')" index="/settings/roles">角色权限</el-menu-item>
          <el-menu-item v-if="auth.showMenu('/settings/profile')" index="/settings/profile">个人设置</el-menu-item>
          <el-menu-item v-if="auth.showMenu('/settings/system-config')" index="/settings/system-config">系统配置</el-menu-item>
        </el-sub-menu>
      </el-menu>
      <!-- 侧边栏底部版本信息 -->
      <div v-if="!collapsed" class="sidebar-footer">
        <span>DB智能平台 v1.1</span>
      </div>
    </aside>

    <div class="main-wrap">
      <header class="top-header">
        <div class="header-left">
          <el-button link @click="collapsed = !collapsed" class="collapse-btn">
            <el-icon size="20"><Fold v-if="!collapsed" /><Expand v-else /></el-icon>
          </el-button>
          <el-breadcrumb separator="/" class="breadcrumb">
            <el-breadcrumb-item :to="{ path: '/dashboard' }">首页</el-breadcrumb-item>
            <el-breadcrumb-item v-if="currentTitle">{{ currentTitle }}</el-breadcrumb-item>
          </el-breadcrumb>
        </div>
        <div class="header-right">
          <el-tooltip content="刷新页面" placement="bottom">
            <el-button link @click="$router.go(0)"><el-icon><Refresh /></el-icon></el-button>
          </el-tooltip>
          <el-tooltip content="全屏" placement="bottom">
            <el-button link @click="toggleFullscreen"><el-icon><FullScreen /></el-icon></el-button>
          </el-tooltip>
          <el-dropdown @command="handleCmd">
            <div class="user-info">
              <el-avatar size="small" :style="{ background: '#1890ff' }">
                {{ auth.user?.username?.[0]?.toUpperCase() }}
              </el-avatar>
              <span class="username">{{ auth.user?.realName || auth.user?.username }}</span>
              <el-tag size="small" :type="roleColor">{{ roleLabel }}</el-tag>
              <el-icon><ArrowDown /></el-icon>
            </div>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="profile" icon="User">个人设置</el-dropdown-item>
                <el-dropdown-item command="pwd" icon="Lock">修改密码</el-dropdown-item>
                <el-dropdown-item command="logout" icon="SwitchButton" divided>退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>
      <main class="main-content">
        <router-view />
      </main>
    </div>

    <!-- 修改密码弹窗 -->
    <el-dialog v-model="pwdVisible" title="修改密码" width="400px" :close-on-click-modal="false">
      <el-form ref="pwdRef" :model="pwdForm" :rules="pwdRules" label-width="90px">
        <el-form-item label="原密码" prop="oldPassword">
          <el-input v-model="pwdForm.oldPassword" type="password" show-password />
        </el-form-item>
        <el-form-item label="新密码" prop="newPassword">
          <el-input v-model="pwdForm.newPassword" type="password" show-password placeholder="≥8位，含大小写字母+数字" />
        </el-form-item>
        <el-form-item label="确认密码" prop="confirmPassword">
          <el-input v-model="pwdForm.confirmPassword" type="password" show-password />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pwdVisible = false">取消</el-button>
        <el-button type="primary" :loading="pwdLoading" @click="submitPwd">确认修改</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, reactive, onMounted, onUnmounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth.js'
import { authApi, alertApi } from '@/api/index.js'
import { ElMessage, ElMessageBox } from 'element-plus'

const router = useRouter()
const route  = useRoute()
const auth   = useAuthStore()
const collapsed = ref(false)
const openAlerts = ref(0)
const pwdVisible = ref(false)
const pwdLoading = ref(false)
const pwdRef = ref()

const titleMap = {
  '/dashboard': '控制台', '/monitor': '监控中心', '/monitor/collect-scheduler': '定时采集观测', '/monitor/compare': '性能对比', '/monitor/custom-metrics': '自定义监控项',
  '/alerts': '告警中心',
  '/cmdb': '资产管理', '/cmdb/hosts': '主机管理', '/cmdb/clusters': '集群拓扑', '/cmdb/app-relation': '应用依赖关系', '/cmdb/tags': '标签管理', '/automation': '自动化运维', '/service-catalog': '服务工单', '/sql': 'SQL优化', '/reports': '报表中心',
  '/settings/users': '用户管理', '/settings/roles': '角色权限', '/settings/profile': '个人设置', '/settings/system-config': '系统配置',
  '/ai': 'AI 智能分析',
  '/sql-review': 'SQL评审',
  '/workbench': 'SQL工作台',
}
const settingsMenuVisible = computed(() =>
  (auth.isAdmin && (auth.showMenu('/settings/users') || auth.showMenu('/settings/roles') || auth.showMenu('/settings/system-config'))) ||
  auth.showMenu('/settings/profile')
)

const activeMenu   = computed(() => {
  if (route.path === '/monitor/collect-scheduler') return '/monitor/collect-scheduler'
  if (route.path === '/monitor/compare') return '/monitor/compare'
  if (route.path === '/monitor/custom-metrics') return '/monitor/custom-metrics'
  if (route.path.startsWith('/monitor/') && route.params.id) return '/monitor'
  if (route.path.startsWith('/automation')) return '/automation'
  return route.path
})
const currentTitle = computed(() => {
  if (route.path === '/monitor/collect-scheduler') return '定时采集观测'
  if (route.path.startsWith('/monitor/') && route.params.id) return '实例详情'
  return titleMap[route.path] || ''
})
const roleMap = {
  ADMIN:    ['超管',     'danger'],
  DBA:      ['DBA',      'warning'],
  OPS:      ['运维',     'primary'],
  REVIEWER: ['审核',     'success'],
  VIEWER:   ['只读',     'info'],
  DEV:      ['开发',     ''],
}
const roleLabel = computed(() => roleMap[auth.user?.role]?.[0] || auth.user?.role)
const roleColor = computed(() => roleMap[auth.user?.role]?.[1] || 'info')

const pwdForm = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' })
const pwdRules = {
  oldPassword:     [{ required: true, message: '请输入原密码' }],
  newPassword:     [{ required: true, message: '请输入新密码' }, { min: 8, message: '至少8位' }],
  confirmPassword: [{ required: true, message: '请确认新密码' },
    { validator: (r, v, cb) => v === pwdForm.newPassword ? cb() : cb(new Error('两次密码不一致')) }],
}

function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen()
  else document.exitFullscreen()
}

async function handleCmd(cmd) {
  if (cmd === 'profile') router.push('/settings/profile')
  else if (cmd === 'pwd') {
    pwdVisible.value = true
    pwdRef.value?.resetFields()
  } else if (cmd === 'logout') {
    await ElMessageBox.confirm('确定要退出登录吗？', '退出确认', { type: 'warning' }).catch(() => null)
    await auth.logout()
    router.push('/login')
  }
}

async function submitPwd() {
  await pwdRef.value.validate(async valid => {
    if (!valid) return
    pwdLoading.value = true
    try {
      const res = await authApi.changePwd(pwdForm)
      if (res.code === 200) {
        ElMessage.success('密码修改成功，请重新登录')
        pwdVisible.value = false
        await auth.logout()
        router.push('/login')
      } else {
        ElMessage.error(res.msg)
      }
    } finally {
      pwdLoading.value = false
    }
  })
}

// 定时刷新告警角标
async function refreshAlertBadge() {
  try {
    const res = await alertApi.stats()
    openAlerts.value = res.data?.byStatus?.find(s => s.STATUS === 'OPEN')?.CNT || 0
  } catch {}
}

let alertTimer = null
onMounted(() => {
  refreshAlertBadge()
  alertTimer = setInterval(refreshAlertBadge, 60000)
})
onUnmounted(() => { if (alertTimer) { clearInterval(alertTimer); alertTimer = null } })
</script>

<style scoped>
.layout-wrap { display: flex; height: 100vh; overflow: hidden; }

.sidebar {
  width: 220px; background: #001529;
  display: flex; flex-direction: column; flex-shrink: 0;
  transition: width 0.25s ease; z-index: 100;
}
.sidebar.collapsed { width: 64px; }

.sidebar-logo {
  height: 56px; display: flex; align-items: center; gap: 10px;
  padding: 0 20px; cursor: pointer; overflow: hidden;
  border-bottom: 1px solid rgba(255,255,255,0.06); flex-shrink: 0;
}
.logo-icon { font-size: 22px; flex-shrink: 0; }
.logo-text { color: #fff; font-size: 15px; font-weight: 700; white-space: nowrap; }

.sidebar-menu { border-right: none; flex: 1; overflow-y: auto; overflow-x: hidden; }
.sidebar-menu:not(.el-menu--collapse) { width: 220px; }

.sidebar-footer {
  padding: 12px 20px; color: rgba(255,255,255,0.3);
  font-size: 12px; border-top: 1px solid rgba(255,255,255,0.06);
  text-align: center;
}
.alert-badge { margin-left: 8px; }

.main-wrap { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

.top-header {
  height: 56px;
  background: var(--agent-panel-bg, #ffffff);
  border-bottom: 1px solid var(--agent-border, #e4e7ed);
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 20px;
  box-shadow: none;
  flex-shrink: 0;
}
.header-left  { display: flex; align-items: center; gap: 12px; }
.header-right { display: flex; align-items: center; gap: 4px; }
.collapse-btn { padding: 6px; color: var(--agent-text-muted, #909399); }

.user-info {
  display: flex; align-items: center; gap: 8px; cursor: pointer;
  padding: 6px 10px; border-radius: 6px; transition: background 0.2s;
}
.user-info:hover { background: rgba(24, 144, 255, 0.08); }
.username { font-size: 14px; color: var(--agent-text, #303133); }

.top-header :deep(.el-breadcrumb__inner),
.top-header :deep(.el-breadcrumb__inner a) {
  color: var(--agent-text-muted, #909399);
  font-weight: 400;
}
.top-header :deep(.el-breadcrumb__item:last-child .el-breadcrumb__inner) {
  color: var(--agent-text, #303133);
  font-weight: 500;
}

.main-content { flex: 1; overflow-y: auto; background: var(--app-page-bg); }
</style>
