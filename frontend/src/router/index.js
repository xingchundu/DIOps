import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth.js'
import { isIdleExpired, clearSession } from '@/utils/session.js'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'Login', component: () => import('@/views/Login.vue'), meta: { public: true } },
    {
      path: '/',
      component: () => import('@/components/layout/MainLayout.vue'),
      children: [
        { path: '',          redirect: '/dashboard' },
        { path: 'dashboard', name: 'Dashboard',   component: () => import('@/views/Dashboard.vue') },
        { path: 'monitor',   name: 'Monitor',     component: () => import('@/views/monitor/InstanceList.vue') },
        { path: 'monitor/:id', name: 'MonitorDetail', component: () => import('@/views/monitor/InstanceDetail.vue') },
        { path: 'monitor/custom-metrics', name: 'CustomMetrics', component: () => import('@/views/monitor/CustomMetrics.vue') },
        { path: 'alerts',    name: 'Alerts',      component: () => import('@/views/alerts/AlertCenter.vue') },
        { path: 'cmdb',      name: 'Cmdb',        component: () => import('@/views/cmdb/AssetManagement.vue') },
        { path: 'cmdb/hosts', name: 'HostManagement', component: () => import('@/views/cmdb/HostManagement.vue') },
        { path: 'cmdb/clusters', name: 'ClusterTopology', component: () => import('@/views/cmdb/ClusterTopology.vue') },
        { path: 'cmdb/app-relation', name: 'AppDbRelation', component: () => import('@/views/cmdb/AppDbRelation.vue') },
        { path: 'cmdb/tags', name: 'TagManagement', component: () => import('@/views/cmdb/TagManagement.vue') },
        { path: 'automation', name: 'Automation', component: () => import('@/views/automation/AutomationCenter.vue') },
        { path: 'service-catalog', name: 'ServiceCatalog', component: () => import('@/views/service/ServiceCatalog.vue') },
        { path: 'sql',       name: 'Sql',         component: () => import('@/views/sql/SqlOptimization.vue') },
        { path: 'sql-review', name: 'SQLReview', component: () => import('@/views/sql/SQLReview.vue') },
        { path: 'sql-insight', name: 'SqlInsight', component: () => import('@/views/sql/SqlInsight.vue') },
        { path: 'workbench', name: 'WebSQL', component: () => import('@/views/sql/WebSQL.vue') },
        { path: 'reports',   name: 'Reports',     component: () => import('@/views/reports/Reports.vue') },
        { path: 'ai',        name: 'AIAnalysis',  component: () => import('@/views/ai/AIAnalysis.vue') },
        { path: 'settings/users',   name: 'Users',   component: () => import('@/views/settings/UserManagement.vue') },
        { path: 'settings/roles',   name: 'Roles',   component: () => import('@/views/settings/RoleManagement.vue') },
        { path: 'settings/profile', name: 'Profile', component: () => import('@/views/settings/Profile.vue') },
        { path: 'settings/system-config', name: 'SystemConfig', component: () => import('@/views/settings/SystemConfig.vue') },
        { path: 'settings/platform-ops', redirect: '/settings/system-config' },
        { path: 'settings/phase1-delivery', redirect: '/alerts' },
        { path: 'settings/phase2-ops', redirect: '/settings/system-config' },
        { path: 'settings/phase3-delivery', redirect: '/settings/system-config' },
        { path: 'settings/system-audit', name: 'SystemAudit', component: () => import('@/views/settings/SystemAudit.vue') },
      ],
    },
    // SQL 监控大屏：全屏页面，不套主框架；权限沿用 /sql-insight 菜单
    { path: '/sql-insight/screen', name: 'SqlInsightScreen', component: () => import('@/views/sql/SqlInsightScreen.vue') },
    // dxc 2026-11-12 OIDC 回调
    { path: '/login/oidc-callback', name: 'LoginOidcCallback', meta: { public: true }, component: () => import('@/views/LoginOidcCallback.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

router.beforeEach(async (to, from, next) => {
  const auth = useAuthStore()
  if (to.meta.public) {
    // 已登录且未超时访问登录页 → 直接进系统
    if (to.path === '/login' && auth.isLoggedIn && !isIdleExpired()) return next(to.query.redirect && String(to.query.redirect).startsWith('/') ? String(to.query.redirect) : '/dashboard')
    return next()
  }
  if (!auth.isLoggedIn) return next({ path: '/login', query: { redirect: to.fullPath } })
  // 关闭浏览器/休眠超过无操作时限后再打开：要求重新登录
  if (isIdleExpired()) {
    auth.$patch({ token: '', user: null })
    clearSession()
    return next({ path: '/login', query: { redirect: to.fullPath, reason: 'idle' } })
  }

  const path = to.path.split('?')[0]
  if (path.startsWith('/settings/users') || path.startsWith('/settings/roles')
      || path.startsWith('/settings/system-audit')) {
    if (!auth.isAdmin) return next('/dashboard')
  }
  if (!auth.canAccessRoute(path)) return next('/dashboard')
  next()
})

export default router
