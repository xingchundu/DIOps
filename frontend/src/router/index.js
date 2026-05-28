import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth.js'

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
        { path: 'monitor/collect-scheduler', name: 'CollectScheduler', component: () => import('@/views/monitor/CollectScheduler.vue') },
        { path: 'monitor',   name: 'Monitor',     component: () => import('@/views/monitor/InstanceList.vue') },
        { path: 'monitor/:id', name: 'MonitorDetail', component: () => import('@/views/monitor/InstanceDetail.vue') },
        { path: 'monitor/compare', name: 'PerfCompare', component: () => import('@/views/monitor/PerformanceCompare.vue') },
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
        { path: 'workbench', name: 'WebSQL', component: () => import('@/views/sql/WebSQL.vue') },
        { path: 'reports',   name: 'Reports',     component: () => import('@/views/reports/Reports.vue') },
        { path: 'ai',        name: 'AIAnalysis',  component: () => import('@/views/ai/AIAnalysis.vue') },
        { path: 'settings/users',   name: 'Users',   component: () => import('@/views/settings/UserManagement.vue') },
        { path: 'settings/roles',   name: 'Roles',   component: () => import('@/views/settings/RoleManagement.vue') },
        { path: 'settings/profile', name: 'Profile', component: () => import('@/views/settings/Profile.vue') },
        { path: 'settings/system-config', name: 'SystemConfig', component: () => import('@/views/settings/SystemConfig.vue') },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

router.beforeEach(async (to, from, next) => {
  const auth = useAuthStore()
  if (to.meta.public) return next()
  if (!auth.isLoggedIn) return next('/login')

  const path = to.path.split('?')[0]
  if (path.startsWith('/settings/users') || path.startsWith('/settings/roles')) {
    if (!auth.isAdmin) return next('/dashboard')
  }
  if (!auth.canAccessRoute(path)) return next('/dashboard')
  next()
})

export default router
