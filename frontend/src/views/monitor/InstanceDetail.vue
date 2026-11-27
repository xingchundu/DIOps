<template>
  <div class="page-container">
    <!-- 顶部信息栏 -->
    <div class="detail-header card mb-16" v-loading="basicLoading">
      <div class="dh-left" v-if="basic">
        <div class="dh-title">
          <el-tag :type="dbTypeColor(basic.DB_TYPE)" size="large">{{ basic.DB_TYPE }}</el-tag>
          <span class="inst-name">{{ basic.INSTANCE_NAME }}</span>
          <span :class="`status-${basic.STATUS?.toLowerCase()}`" class="status-chip">
            ● {{ statusLabel(basic.STATUS) }}
          </span>
        </div>
        <div class="dh-meta">
          <span><el-icon><Location /></el-icon> {{ basic.HOST_IP }}:{{ basic.PORT }}</span>
          <span><el-icon><Monitor /></el-icon> {{ basic.HOSTNAME || basic.HOST_IP }}</span>
          <span><el-icon><OfficeBuilding /></el-icon> {{ basic.BIZ_LINE || '-' }}</span>
          <el-tag size="small">{{ basic.ENVIRONMENT }}</el-tag>
          <el-tag size="small" type="info">{{ basic.ROLE }}</el-tag>
        </div>
      </div>
      <div class="dh-right" v-if="basic">
        <div class="score-circle" :style="scoreStyle(basic.STATUS === 'ERROR' ? null : basic.HEALTH_SCORE)">
          <div class="score-num">{{ basic.STATUS === 'ERROR' ? '离线' : (basic.HEALTH_SCORE ?? '-') }}</div>
          <div class="score-text">{{ basic.STATUS === 'ERROR' ? '连接失败' : gradeOf(gradeKey(basic.HEALTH_SCORE)).label }}</div>
        </div>
        <div class="dh-actions">
          <el-badge v-if="basic.OPEN_ALERTS > 0" :value="basic.OPEN_ALERTS" type="danger">
            <el-button size="small" type="danger" plain @click="activeTab='alerts'">未处理告警</el-button>
          </el-badge>
          <el-button size="small" type="primary" :loading="collectingNow" @click="runCollectNow">立即采集</el-button>
          <el-button size="small" icon="Refresh" @click="refreshCurrent">刷新</el-button>
          <el-popover v-if="canSetCollectSchedule" placement="bottom" :width="320" trigger="click">
            <template #reference>
              <el-button size="small" icon="Timer">采集间隔</el-button>
            </template>
            <div class="collect-schedule-pop">
              <div class="text-muted mb-8">本实例自动采集（与全局限频任务并存）；留空/0 表示关闭</div>
              <el-input-number
                v-model="collectIntervalMin"
                :min="0"
                :max="1440"
                :step="1"
                controls-position="right"
                style="width:100%"
              />
              <div class="text-muted" style="font-size:11px;margin-top:6px">单位：分钟（≥1 即至少 60 秒）</div>
              <el-button type="primary" size="small" class="mt-12" :loading="savingCollectSchedule" @click="saveCollectSchedule">
                保存
              </el-button>
            </div>
          </el-popover>
          <el-button size="small" icon="ArrowLeft" @click="$router.back()">返回</el-button>
        </div>
      </div>
    </div>

    <!-- 9大Tab -->
    <el-tabs v-model="activeTab" type="card" class="detail-tabs" @tab-click="onTabChange">
      <!-- ① 基本信息 -->
      <el-tab-pane label="① 基本信息" name="basic">
        <div v-loading="basicLoading" class="card">
          <el-row :gutter="24" v-if="basic && sysinfo">
            <el-col :span="12">
              <div class="card-title">实例元数据</div>
              <el-descriptions :column="1" border size="small">
                <el-descriptions-item label="实例名称">{{ basic.INSTANCE_NAME }}</el-descriptions-item>
                <el-descriptions-item label="数据库类型">{{ basic.DB_TYPE }} {{ basic.DB_VERSION }}</el-descriptions-item>
                <el-descriptions-item label="主机IP/端口">{{ basic.HOST_IP }} : {{ basic.PORT }}</el-descriptions-item>
                <el-descriptions-item label="SID / Service">{{ basic.SID || '-' }} / {{ basic.SERVICE_NAME || '-' }}</el-descriptions-item>
                <el-descriptions-item label="字符集">{{ basic.CHARSET || '-' }}</el-descriptions-item>
                <el-descriptions-item label="环境/业务线">{{ basic.ENVIRONMENT }} / {{ basic.BIZ_LINE || '-' }}</el-descriptions-item>
                <el-descriptions-item label="实例角色">{{ basic.ROLE }}</el-descriptions-item>
                <el-descriptions-item label="纳管时间">{{ fmt(basic.CREATED_AT) }}</el-descriptions-item>
                <el-descriptions-item label="最后采集">{{ fmt(basic.LAST_CHECK) || '未采集' }}</el-descriptions-item>
                <el-descriptions-item label="本实例采集间隔">
                  {{ collectIntervalLabel }}
                </el-descriptions-item>
              </el-descriptions>
            </el-col>
            <el-col :span="12">
              <div class="card-title">数据库实例信息</div>
              <el-descriptions :column="1" border size="small" v-if="sysinfo.instance">
                <el-descriptions-item label="实例名">{{ sysinfo.instance.INSTANCE_NAME }}</el-descriptions-item>
                <el-descriptions-item label="版本">{{ sysinfo.instance.VERSION }}</el-descriptions-item>
                <el-descriptions-item label="启动时间">{{ sysinfo.instance.STARTUP_TIME }}</el-descriptions-item>
                <el-descriptions-item label="状态">{{ sysinfo.instance.STATUS }}</el-descriptions-item>
                <el-descriptions-item label="数据库角色">{{ sysinfo.database?.DATABASE_ROLE }}</el-descriptions-item>
                <el-descriptions-item label="日志模式">{{ sysinfo.database?.LOG_MODE }}</el-descriptions-item>
                <el-descriptions-item label="开库模式">{{ sysinfo.database?.OPEN_MODE }}</el-descriptions-item>
                <el-descriptions-item label="DB唯一名">{{ sysinfo.database?.DB_UNIQUE_NAME }}</el-descriptions-item>
              </el-descriptions>
              <el-empty v-else description="实例信息获取失败，请检查连接配置与账号权限" />
            </el-col>
          </el-row>
          <!-- 健康评分（扣分制，可解释） -->
          <el-divider content-position="left">健康评分</el-divider>
          <div v-if="healthDetail && (healthDetail.dimensions || healthDetail.grade)" class="health">
            <div class="health-head">
              <span class="h-grade" :style="{ color: gradeOf(healthDetail.grade).color, background: gradeOf(healthDetail.grade).bg }">{{ gradeOf(healthDetail.grade).label }}</span>
              <span v-if="healthDetail.score != null" class="h-score" :style="{ color: gradeOf(healthDetail.grade).color }">{{ healthDetail.score }}</span>
              <span class="text-gray">已检查 {{ healthDetail.checked ?? '-' }} 项 · 采集于 {{ fmt(healthDetail.collectedAt) }}</span>
              <el-popover placement="bottom" :width="420" trigger="click">
                <template #reference><el-button link type="info" size="small" icon="QuestionFilled">评分规则</el-button></template>
                <ol class="rules"><li v-for="r in RULE_TEXT" :key="r">{{ r }}</li></ol>
              </el-popover>
            </div>
            <el-alert v-if="healthDetail.error" :title="`连接失败：${healthDetail.error}`" type="error" :closable="false" show-icon class="mb-16"
                      :description="healthDetail.errorDetail" />
            <el-row v-if="!healthDetail.legacy" :gutter="24">
              <el-col :span="10">
                <div class="h-sub">分类结论</div>
                <div v-for="(c, k) in healthDetail.dimensions || {}" :key="k" class="h-cat">
                  <span class="h-cat-label">{{ c.label }}</span>
                  <span class="h-pill" :class="c.status">{{ { OK: '正常', WARN: '警告', CRIT: '严重', NA: '未采集' }[c.status] || c.status }}</span>
                  <span class="h-cat-detail" :title="c.detail">{{ c.detail }}</span>
                </div>
              </el-col>
              <el-col :span="14">
                <div class="h-sub">扣分项</div>
                <el-table v-if="(healthDetail.issues || []).length" :data="healthDetail.issues" size="small">
                  <el-table-column label="级别" width="70"><template #default="{ row }"><span class="h-pill" :class="row.level">{{ row.level === 'CRIT' ? '严重' : '警告' }}</span></template></el-table-column>
                  <el-table-column prop="categoryLabel" label="分类" width="90" />
                  <el-table-column prop="text" label="问题" min-width="200" show-overflow-tooltip />
                  <el-table-column label="扣分" width="60"><template #default="{ row }">-{{ row.deduct }}</template></el-table-column>
                </el-table>
                <div v-else class="h-ok">没有扣分项</div>
              </el-col>
            </el-row>
            <div v-else class="text-gray">该样本为旧版评分，下一次采集后显示新的评分明细。</div>
          </div>
          <el-empty v-else-if="!healthDetailLoading" description="暂无健康评分，请点击右上角“立即采集”或等待下次采集" />
        </div>
      </el-tab-pane>

      <!-- ② 实时性能 -->
      <el-tab-pane label="② 实时性能" name="perf">
        <div class="card" v-loading="perfLoading">
          <div class="card-title" style="justify-content:space-between">
            <span><el-icon><DataAnalysis /></el-icon> 关键指标<span v-if="perf.exporter?.scrape_ts" class="text-gray" style="font-weight: normal; font-size: 12px; margin-left: 8px">采集于 {{ fmt(perf.exporter.scrape_ts) }}</span></span>
            <el-button size="small" icon="Refresh" @click="loadPerf">刷新</el-button>
          </div>
          <el-row :gutter="16" class="mb-16">
            <el-col :span="6" v-for="m in keyMetrics" :key="m.name">
              <div class="metric-card" :class="m.alertClass">
                <div class="metric-val">{{ m.val }}</div>
                <div class="metric-name">{{ m.name }}</div>
                <div class="metric-unit">{{ m.unit }}</div>
              </div>
            </el-col>
          </el-row>
          <el-row :gutter="16">
            <el-col :span="12">
              <div class="sub-title">会话状态</div>
              <div ref="sessChartRef" style="height:200px"></div>
            </el-col>
            <el-col :span="12">
              <div class="sub-title">等待事件 Top5</div>
              <el-table :data="waitsData.slice(0,5)" size="small" stripe>
                <el-table-column prop="EVENT" label="等待事件" show-overflow-tooltip />
                <el-table-column prop="WAIT_CLASS" label="类型" width="100" />
                <el-table-column prop="AVG_WAIT_MS" label="均等待(ms)" width="100" />
              </el-table>
            </el-col>
          </el-row>
        </div>
      </el-tab-pane>

      <!-- [dxc][2026-10-08][新增] 深度监控 Tab（Oracle/磐维）— 原因：展示采集 engineMetrics + enginePhase2Summary -->
      <el-tab-pane v-if="showEnginePhase2" label="②+ 深度监控" name="engine-phase2">
        <div class="card" v-loading="phase2Loading">
          <div class="card-title" style="justify-content:space-between">
            <span><el-icon><Odometer /></el-icon> 深度监控摘要（争用 / 告警日志 / TOP SQL）</span>
            <div class="flex-center gap-8">
              <span v-if="phase2CollectedAt" class="text-muted">样本时间：{{ fmt(phase2CollectedAt) }}</span>
              <el-button size="small" icon="Refresh" @click="loadEnginePhase2">刷新</el-button>
            </div>
          </div>
          <el-alert type="info" :closable="false" class="mb-16" show-icon>
            数据来自周期采集；暂无数据时可点击右上角「立即采集」。
          </el-alert>
          <el-row :gutter="12" class="mb-16" v-if="phase2MetricCards.length">
            <el-col :span="6" v-for="m in phase2MetricCards" :key="m.key">
              <div class="metric-card" :class="m.alertClass">
                <div class="metric-val">{{ m.val }}</div>
                <div class="metric-name">{{ m.label }}</div>
                <div class="metric-unit">{{ m.unit }}</div>
              </div>
            </el-col>
          </el-row>
          <el-empty v-else-if="!phase2Loading" description="暂无深度指标，等待下次采集" />

          <el-row :gutter="16" v-if="phase2Summary">
            <el-col :span="12" v-if="phase2Summary.topWaits?.length">
              <div class="sub-title">Top 等待事件</div>
              <el-table :data="phase2Summary.topWaits" size="small" stripe border>
                <el-table-column prop="event" label="事件" show-overflow-tooltip />
                <el-table-column prop="waitClass" label="类型" width="100" />
                <el-table-column label="累计(μs)" width="120">
                  <template #default="{ row }">{{ row.timeWaitedMicro ?? row.time_waited_micro ?? '-' }}</template>
                </el-table-column>
              </el-table>
            </el-col>
            <el-col :span="12" v-if="phase2Summary.topSql?.length">
              <div class="sub-title">Top SQL 摘要</div>
              <el-table :data="phase2Summary.topSql" size="small" stripe border>
                <el-table-column prop="sqlId" label="SQL_ID / queryId" width="120">
                  <template #default="{ row }">{{ row.sqlId || row.queryId || '-' }}</template>
                </el-table-column>
                <el-table-column prop="executions" label="次数" width="80">
                  <template #default="{ row }">{{ row.executions ?? row.calls ?? '-' }}</template>
                </el-table-column>
                <el-table-column label="耗时" min-width="100">
                  <template #default="{ row }">
                    {{ row.elapsedSec != null ? row.elapsedSec + 's' : (row.meanTimeMs != null ? row.meanTimeMs + 'ms' : '-') }}
                  </template>
                </el-table-column>
              </el-table>
            </el-col>
            <el-col :span="24" v-if="phase2Summary.alertHits?.length" class="mt-12">
              <div class="sub-title">近24h 告警日志命中</div>
              <el-tag v-for="t in phase2Summary.alertHits" :key="t" type="danger" class="mr-8">{{ t }}</el-tag>
            </el-col>
            <el-col :span="24" v-if="phase2Summary.replication?.length" class="mt-12">
              <div class="sub-title">主备复制状态</div>
              <el-table :data="phase2Summary.replication" size="small" stripe border>
                <el-table-column prop="addr" label="备库地址" show-overflow-tooltip>
                  <template #default="{ row }">{{ row.addr || row.client_addr || '-' }}</template>
                </el-table-column>
                <el-table-column prop="state" label="state" width="120" />
                <el-table-column prop="sync_state" label="sync" width="100" />
              </el-table>
            </el-col>
            <el-col :span="24" v-if="phase2Summary.databaseRole" class="mt-12">
              <el-descriptions :column="3" border size="small">
                <el-descriptions-item label="库角色">{{ phase2Summary.databaseRole }}</el-descriptions-item>
                <el-descriptions-item label="日志模式">{{ phase2Summary.logMode || '-' }}</el-descriptions-item>
              </el-descriptions>
            </el-col>
          </el-row>

          <!-- [dxc][2026-10-08][新增] 主机 SSH 摘要 -->
          <el-divider v-if="showEnginePhase2" content-position="left">主机 SSH</el-divider>
          <el-alert v-if="hostSummary?.skip" type="warning" :closable="false" class="mb-16" show-icon>
            未采集主机指标：{{ hostSkipHint }}。请在 CMDB 主机上启用 SSH（SSH_ENABLED=1、用户/密钥）并绑定实例 HOST_ID。
          </el-alert>
          <el-row :gutter="12" class="mb-16" v-if="hostMetricCards.length">
            <el-col :span="6" v-for="m in hostMetricCards" :key="m.key">
              <div class="metric-card" :class="m.alertClass">
                <div class="metric-val">{{ m.val }}</div>
                <div class="metric-name">{{ m.label }}</div>
                <div class="metric-unit">{{ m.unit }}</div>
              </div>
            </el-col>
          </el-row>
          <el-row :gutter="16" v-if="hostSummary?.filesystems?.length">
            <el-col :span="24">
              <div class="sub-title">文件系统 (df)</div>
              <el-table :data="hostSummary.filesystems" size="small" stripe border>
                <el-table-column prop="device" label="设备" show-overflow-tooltip />
                <el-table-column prop="mount" label="挂载点" width="140" />
                <el-table-column label="使用率" width="120">
                  <template #default="{ row }">
                    <span :class="row.usedPct >= 95 ? 'text-danger' : row.usedPct >= 85 ? 'text-warn' : ''">{{ row.usedPct }}%</span>
                  </template>
                </el-table-column>
              </el-table>
            </el-col>
          </el-row>
          <el-collapse v-if="hostSummary?.listener?.excerpt || hostSummary?.crs?.excerpt || hostSummary?.gsOm?.excerpt" class="mt-12">
            <el-collapse-item title="Shell 采集原文摘要" name="raw">
              <pre class="host-raw">{{ hostRawExcerpt }}</pre>
            </el-collapse-item>
          </el-collapse>
        </div>
      </el-tab-pane>

      <!-- ③ 表空间 -->
      <el-tab-pane label="③ 表空间" name="tablespaces">
        <div class="card" v-loading="tsLoading">
          <el-alert v-if="tsFootnote" :type="tsError ? 'error' : 'info'" :closable="false" class="mb-16">{{ tsFootnote }}</el-alert>
          <div class="card-title" style="justify-content:space-between">
            <span><el-icon><Coin /></el-icon> 表空间使用情况</span>
            <div class="ts-actions">
              <el-button size="small" @click="openDiag">运行自检</el-button>
              <el-button size="small" icon="Refresh" @click="loadTablespaces">刷新</el-button>
            </div>
          </div>
          <el-table :data="tablespaces" stripe border>
            <el-table-column prop="TABLESPACE_NAME" label="表空间名" min-width="150" />
            <el-table-column prop="TOTAL_GB" label="总大小(GB)" width="110" />
            <el-table-column prop="USED_GB" label="已用(GB)" width="110" />
            <el-table-column prop="FREE_GB" label="剩余(GB)" width="110" />
            <el-table-column label="使用率" min-width="160">
              <template #default="{ row }">
                <el-progress v-if="row.USED_PCT != null && row.USED_PCT !== ''"
                  :percentage="Math.min(100, Math.max(0, Number(row.USED_PCT) || 0))"
                  :color="row.USED_PCT>=90 ? '#ff4d4f' : row.USED_PCT>=80 ? '#faad14' : '#52c41a'"
                  :stroke-width="10" />
                <span v-else class="muted">未设上限</span>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>

      <!-- ④ SQL 洞察：该实例的问题 SQL、异常波动、慢 SQL（与 SQL洞察页面同一组件；原“④ SQL分析”实时 Top SQL 已并入） -->
      <el-tab-pane label="④ SQL洞察" name="sql-insight" lazy>
        <SqlInsight :instance-id="id" embedded />
      </el-tab-pane>

      <!-- ⑤ 会话 -->
      <el-tab-pane label="⑤ 会话管理" name="sessions">
        <div class="card" v-loading="sessLoading">
          <div class="card-title" style="justify-content:space-between">
            <span><el-icon><User /></el-icon> 当前会话</span>
            <div class="flex-center gap-8">
              <el-switch v-model="onlyActive" active-text="仅活跃" @change="loadSessions" />
              <el-button size="small" icon="Refresh" @click="loadSessions">刷新</el-button>
            </div>
          </div>
          <el-table :data="sessions" stripe border size="small" height="420">
            <el-table-column prop="SID" label="SID" width="70" />
            <el-table-column prop="SERIAL#" label="SERIAL#" width="80" />
            <el-table-column prop="USERNAME" label="用户" width="120" />
            <el-table-column prop="STATUS" label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="isSessActive(row.STATUS) ? 'danger' : 'info'" size="small">{{ row.STATUS }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="WAIT_CLASS" label="等待类型" width="120" show-overflow-tooltip />
            <el-table-column prop="EVENT" label="等待事件" min-width="160" show-overflow-tooltip />
            <el-table-column prop="WAIT_MIN" label="等待(分)" width="90" />
            <el-table-column prop="PROGRAM" label="程序" min-width="140" show-overflow-tooltip />
            <el-table-column prop="SQL_TEXT" label="SQL(摘要)" min-width="200" show-overflow-tooltip />
            <el-table-column label="操作" width="80" fixed="right">
              <template #default="{ row }">
                <el-popconfirm v-if="isOracle" :title="`确定Kill会话 SID=${row.SID}?`" @confirm="killSess(row)">
                  <template #reference>
                    <el-button link type="danger" size="small">Kill</el-button>
                  </template>
                </el-popconfirm>
                <span v-else class="text-muted">—</span>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>

      <!-- ⑥ 告警汇总 -->
      <el-tab-pane label="⑥ 告警汇总" name="alerts">
        <div class="card" v-loading="alertsLoading">
          <div class="card-title" style="justify-content:space-between">
            <span><el-icon><Bell /></el-icon> 近期告警</span>
            <el-button size="small" @click="$router.push('/alerts')">查看全部告警</el-button>
          </div>
          <el-table :data="instAlerts" stripe border size="small">
            <el-table-column label="级别" width="80">
              <template #default="{ row }">
                <span :class="`badge-${row.SEVERITY?.toLowerCase()}`">{{ row.SEVERITY }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="CONTENT" label="告警内容" min-width="280" show-overflow-tooltip />
            <el-table-column label="状态" width="110">
              <template #default="{ row }">
                <el-tag :type="alertStatusType(row.STATUS)" size="small">{{ alertStatusLabel(row.STATUS) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="触发时间" width="155" :formatter="(r,c,v) => fmt(v)" prop="TRIGGER_TIME" />
            <el-table-column prop="ACK_BY" label="处理人" width="100" />
          </el-table>
        </div>
      </el-tab-pane>

      <!-- ⑦ 历史趋势 -->
      <el-tab-pane label="⑦ 历史趋势" name="trend">
        <div class="card">
          <div class="card-title" style="justify-content:space-between">
            <span><el-icon><TrendCharts /></el-icon> 历史性能趋势</span>
            <el-radio-group v-model="trendRange" size="small" @change="loadTrend">
              <el-radio-button label="1h">1小时</el-radio-button>
              <el-radio-button label="6h">6小时</el-radio-button>
              <el-radio-button label="1d">1天</el-radio-button>
              <el-radio-button label="7d">7天</el-radio-button>
            </el-radio-group>
          </div>
          <div class="text-gray" style="font-size: 12px; margin-bottom: 12px">数据来自周期采集（默认约 90 秒一次），进入本页会立即采集一次。</div>
          <el-row :gutter="16">
            <el-col :span="12"><div ref="cpuChartRef" style="height:200px"></div></el-col>
            <el-col :span="12"><div ref="connChartRef" style="height:200px"></div></el-col>
          </el-row>
        </div>
      </el-tab-pane>

      <!-- ⑧ 等待事件分析 -->
      <el-tab-pane label="⑧ 等待事件" name="waits">
        <div class="card" v-loading="waitsLoading">
          <div class="card-title" style="justify-content:space-between">
            <span><el-icon><Odometer /></el-icon> 等待事件分析</span>
            <el-button size="small" icon="Refresh" @click="loadWaits">刷新</el-button>
          </div>
          <el-row :gutter="16" class="mb-16">
            <el-col :span="12">
              <div class="sub-title">等待时间分布（按等待类）</div>
              <div ref="waitClassChartRef" style="height:260px"></div>
            </el-col>
            <el-col :span="12">
              <div class="sub-title">Top 10 等待事件（按累计等待时间）</div>
              <div ref="waitEventChartRef" style="height:260px"></div>
            </el-col>
          </el-row>
          <div class="sub-title">全部等待事件明细</div>
          <el-table :data="allWaits" stripe border size="small" max-height="380">
            <el-table-column prop="EVENT" label="等待事件" min-width="220" show-overflow-tooltip />
            <el-table-column prop="WAIT_CLASS" label="等待类" width="130">
              <template #default="{ row }">
                <el-tag size="small" :type="waitClassColor(row.WAIT_CLASS)">{{ row.WAIT_CLASS }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="TOTAL_WAITS" label="总等待次数" width="120" align="right">
              <template #default="{ row }">{{ row.TOTAL_WAITS?.toLocaleString() }}</template>
            </el-table-column>
            <el-table-column prop="TOTAL_TIMEOUTS" label="超时次数" width="100" align="right">
              <template #default="{ row }">{{ row.TOTAL_TIMEOUTS?.toLocaleString() }}</template>
            </el-table-column>
            <el-table-column prop="TIME_WAITED_SEC" label="累计等待(s)" width="120" align="right">
              <template #default="{ row }">
                <span :style="{ color: row.TIME_WAITED_SEC > 100 ? '#F56C6C' : row.TIME_WAITED_SEC > 10 ? '#E6A23C' : '' }">
                  {{ row.TIME_WAITED_SEC?.toLocaleString() }}
                </span>
              </template>
            </el-table-column>
            <el-table-column prop="AVG_WAIT_MS" label="平均等待(ms)" width="120" align="right">
              <template #default="{ row }">
                <span :style="{ color: row.AVG_WAIT_MS > 100 ? '#F56C6C' : row.AVG_WAIT_MS > 10 ? '#E6A23C' : '' }">
                  {{ row.AVG_WAIT_MS?.toFixed(2) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="超时率" width="100" align="right">
              <template #default="{ row }">
                <span v-if="row.TOTAL_WAITS > 0" :style="{ color: (row.TOTAL_TIMEOUTS / row.TOTAL_WAITS) > 0.1 ? '#F56C6C' : '' }">
                  {{ ((row.TOTAL_TIMEOUTS / row.TOTAL_WAITS) * 100).toFixed(1) }}%
                </span>
                <span v-else>-</span>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>

      <!-- ⑨ 锁分析 -->
      <el-tab-pane label="⑨ 锁分析" name="locks" v-if="isOracle">
        <div class="card" v-loading="locksLoading">
          <div class="card-title" style="justify-content:space-between">
            <span><el-icon><Lock /></el-icon> 锁分析（Oracle V$LOCK）</span>
            <el-button size="small" icon="Refresh" @click="loadLocks">刷新</el-button>
          </div>
          <el-alert v-if="locks.length === 0 && !locksLoading" type="success" :closable="false" show-icon class="mb-16">
            当前无锁等待，数据库运行正常
          </el-alert>
          <template v-else>
            <el-alert type="warning" :closable="false" show-icon class="mb-16">
              检测到 {{ locks.length }} 组锁等待，请关注持有者会话
            </el-alert>
            <div class="sub-title">锁等待链</div>
            <div class="lock-chain mb-16">
              <div v-for="(lk, idx) in locks" :key="idx" class="lock-chain-item">
                <div class="lock-node lock-holder">
                  <div class="lock-node-title">持有者</div>
                  <div class="lock-node-body">
                    <span class="lock-sid">SID={{ lk.HOLDER_SID }}</span>
                    <span class="lock-user">{{ lk.HOLDER_USER || '-' }}</span>
                    <span class="lock-prog">{{ lk.HOLDER_PROG || '-' }}</span>
                  </div>
                </div>
                <div class="lock-arrow">
                  <el-icon size="20" color="#E6A23C"><Right /></el-icon>
                  <span class="lock-wait-info">阻塞 {{ lk.WAIT_MIN }} 分钟</span>
                </div>
                <div class="lock-node lock-waiter">
                  <div class="lock-node-title">等待者</div>
                  <div class="lock-node-body">
                    <span class="lock-sid">SID={{ lk.WAITER_SID }}</span>
                    <span class="lock-user">{{ lk.WAITER_USER || '-' }}</span>
                    <span class="lock-prog">{{ lk.WAITER_PROG || '-' }}</span>
                  </div>
                </div>
                <el-tag size="small" type="info" class="lock-event-tag">{{ lk.WAIT_EVENT || '-' }}</el-tag>
              </div>
            </div>
          </template>
          <div class="sub-title">锁等待明细</div>
          <el-table :data="locks" stripe border size="small">
            <el-table-column label="持有者 SID" width="100" align="center">
              <template #default="{ row }">
                <el-tag type="danger" size="small">{{ row.HOLDER_SID }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="HOLDER_SERIAL" label="Serial#" width="80" />
            <el-table-column prop="HOLDER_USER" label="持有者用户" width="120" />
            <el-table-column prop="HOLDER_PROG" label="持有者程序" min-width="160" show-overflow-tooltip />
            <el-table-column label="等待者 SID" width="100" align="center">
              <template #default="{ row }">
                <el-tag type="warning" size="small">{{ row.WAITER_SID }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="WAITER_SERIAL" label="Serial#" width="80" />
            <el-table-column prop="WAITER_USER" label="等待者用户" width="120" />
            <el-table-column prop="WAITER_PROG" label="等待者程序" min-width="160" show-overflow-tooltip />
            <el-table-column prop="WAIT_MIN" label="等待(分)" width="100" align="right">
              <template #default="{ row }">
                <span :style="{ color: row.WAIT_MIN > 10 ? '#F56C6C' : row.WAIT_MIN > 5 ? '#E6A23C' : '' }" style="font-weight: 600">
                  {{ row.WAIT_MIN }}
                </span>
              </template>
            </el-table-column>
            <el-table-column prop="WAIT_EVENT" label="等待事件" width="160" show-overflow-tooltip />
          </el-table>
        </div>
      </el-tab-pane>

      <!-- ⑩ AWR快照 -->
      <el-tab-pane label="⑩ AWR快照" name="awr" v-if="isOracle">
        <div class="card" v-loading="awrLoading">
          <div class="card-title" style="justify-content:space-between">
            <span><el-icon><Files /></el-icon> AWR快照列表</span>
            <el-button size="small" icon="Refresh" @click="loadAwr">刷新</el-button>
          </div>
          <el-alert v-if="!canSetCollectSchedule" type="warning" :closable="false" class="mb-16" show-icon>
            生成 AWR 报告需要 <strong>ADMIN/DBA</strong> 平台角色；快照列表所有登录用户可查看。
          </el-alert>
          <el-alert type="info" :closable="false" class="mb-16">
            勾选至少 2 条快照（建议相邻两条），生成 HTML 报告（可浏览器打开 / 下载 .html）；可选文本版；需被管库 AWR 与 DBMS_WORKLOAD_REPOSITORY 权限。
          </el-alert>
          <el-table :data="awrSnaps" stripe border size="small" height="400"
            @selection-change="awrSel = $event" highlight-current-row>
            <el-table-column type="selection" width="50" />
            <el-table-column prop="SNAP_ID"     label="SNAP_ID" width="90" />
            <el-table-column prop="BEGIN_TIME"  label="开始时间" width="155" />
            <el-table-column prop="END_TIME"    label="结束时间" width="155" />
            <el-table-column prop="INSTANCE_NUMBER" label="实例号" width="80" />
          </el-table>
          <div style="margin-top:12px;text-align:right;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
            <el-button
              type="primary"
              :disabled="awrSel.length < 2 || !canSetCollectSchedule"
              :loading="awrReportLoading"
              @click="genAwr('html')"
            >生成 HTML 报告</el-button>
            <el-button
              :disabled="awrSel.length < 2 || !canSetCollectSchedule"
              :loading="awrReportLoading"
              @click="genAwr('text')"
            >生成文本报告</el-button>
          </div>
        </div>
      </el-tab-pane>

      <el-dialog v-model="awrReportVisible" :title="awrReportFormat === 'html' ? 'AWR 报告 (HTML)' : 'AWR 报告 (文本)'" width="85%" top="4vh" destroy-on-close>
        <div class="mb-16" style="text-align:right">
          <el-button size="small" type="primary" @click="downloadAwrReport">
            下载 .{{ awrReportFormat === 'html' ? 'html' : 'txt' }}
          </el-button>
        </div>
        <iframe
          v-if="awrReportFormat === 'html' && awrReportContent"
          class="awr-report-iframe"
          sandbox="allow-same-origin"
          :srcdoc="awrReportContent"
        />
        <pre v-else class="awr-report-pre">{{ awrReportContent || '（无内容）' }}</pre>
      </el-dialog>

      <!-- ⑪ 操作记录 -->
      <el-tab-pane label="⑪ 操作记录" name="audit">
        <div class="card" v-loading="auditLoading">
          <div class="card-title"><el-icon><List /></el-icon> 平台操作审计</div>
          <el-table :data="auditLogs" stripe border size="small" height="420">
            <el-table-column prop="USERNAME"   label="操作人"  width="110" />
            <el-table-column prop="ACTION"     label="操作类型" width="140" />
            <el-table-column prop="STATUS"     label="结果" width="80">
              <template #default="{ row }">
                <el-tag :type="row.STATUS === 'SUCCESS' ? 'success' : 'danger'" size="small">{{ row.STATUS }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="IP_ADDR"    label="来源IP" width="120" />
            <el-table-column prop="DETAIL"     label="详情" min-width="200" show-overflow-tooltip />
            <el-table-column prop="CREATED_AT" label="时间" width="155" :formatter="(r,c,v) => fmt(v)" />
          </el-table>
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- 运行自检：表空间查询链路 / 接口契约 / 巡检报告体检 -->
    <el-dialog v-model="diagVisible" title="运行自检" width="880px" top="6vh" destroy-on-close>
      <div v-loading="diagLoading">
        <el-alert v-if="diagResult" :closable="false" class="mb-16"
          :type="diagResult.ok ? 'success' : (diagResult.skipped ? 'info' : 'error')"
          :title="diagResult.skipped ? diagResult.reason : (diagResult.ok ? '表空间链路正常' : '表空间链路异常')"
          :description="diagResult.advice || diagResult.connectError || diagResult.versionError || ''" />
        <template v-if="diagResult">
          <div class="diag-meta">
            <span>实例：{{ diagResult.instanceName || diagResult.instanceId }}</span>
            <span>地址：{{ diagResult.hostIp }}:{{ diagResult.port }}</span>
            <span>账号：{{ diagResult.dbUser }}</span>
            <span>版本：{{ diagResult.version || '不可读（不影响 19c 语句）' }}</span>
            <span>生效口径：{{ diagResult.activeStrategy || '无' }}</span>
          </div>
          <el-table :data="diagResult.probes || []" size="small" border stripe>
            <el-table-column prop="name" label="查询语句" min-width="240" />
            <el-table-column label="结果" width="92">
              <template #default="{ row }">
                <el-tag :type="row.ok ? (row.degraded ? 'warning' : 'success') : 'danger'" size="small">
                  {{ row.ok ? (row.degraded ? '仅名称' : '成功') : '失败' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="rows" label="行数" width="70" />
            <el-table-column label="原始错误 / 返回样例" min-width="280" show-overflow-tooltip>
              <template #default="{ row }">
                <span :class="{ 'diag-err': !row.ok }">{{ row.error || (row.sample ? JSON.stringify(row.sample) : '') }}</span>
              </template>
            </el-table-column>
          </el-table>
        </template>
        <el-empty v-else description="点击「开始自检」验证本实例的表空间查询链路" :image-size="70" />
      </div>
      <template #footer>
        <div class="diag-footer">
          <el-button size="small" :loading="diagExtraLoading" @click="runExtraDiag('routes')">检查接口契约</el-button>
          <el-button size="small" :loading="diagExtraLoading" @click="runExtraDiag('reports')">检查巡检报告</el-button>
          <span class="diag-spacer" />
          <el-button @click="diagVisible = false">关闭</el-button>
          <el-button type="primary" :loading="diagLoading" @click="runTargetDiag">开始自检</el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="diagExtraVisible" title="自检结果（原始数据）" width="820px" top="6vh">
      <pre class="diag-json">{{ diagExtraText }}</pre>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth.js'
import { monitorApi, diagnosticsApi } from '@/api/index.js'
import SqlInsight from '@/views/sql/SqlInsight.vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as echarts from 'echarts'
import { grade as gradeOf, RULE_TEXT } from '@/components/monitor/health.js'

const route  = useRoute()
const router = useRouter()
const auth   = useAuthStore()
const id     = computed(() => route.params.id)

const canSetCollectSchedule = computed(() => auth.isDBA)
const collectingNow = ref(false)
const savingCollectSchedule = ref(false)
const collectIntervalMin = ref(0)

const collectIntervalLabel = computed(() => {
  const sec = Number(basic.value?.COLLECT_INTERVAL_SEC)
  if (!Number.isFinite(sec) || sec <= 0) return '未设置（仅全局限频采集）'
  if (sec % 60 === 0) return `每 ${sec / 60} 分钟`
  return `每 ${sec} 秒`
})

const activeTab   = ref('basic')
const onlyActive  = ref(false)
const trendRange  = ref('1h')
const awrSel      = ref([])

// Data
const basic      = ref(null); const basicLoading  = ref(false)
const sysinfo    = ref(null)
const perf       = ref({});   const perfLoading   = ref(false)
const waitsData  = ref([])
const tablespaces= ref([]);   const tsLoading     = ref(false); const tsError = ref('')
// 运行自检（表空间链路 / 接口契约 / 巡检报告体检）
const diagVisible = ref(false);  const diagLoading = ref(false);  const diagResult = ref(null)
const diagExtraVisible = ref(false); const diagExtraLoading = ref(false); const diagExtraText = ref('')
const sessions   = ref([]);   const sessLoading   = ref(false)
const instAlerts = ref([]);   const alertsLoading = ref(false)
const awrSnaps   = ref([]);   const awrLoading    = ref(false)
const awrReportVisible = ref(false)
const awrReportContent = ref('')
const awrReportFormat = ref('html')
const awrReportLoading = ref(false)
const auditLogs  = ref([]);   const auditLoading  = ref(false)
const allWaits   = ref([]);   const waitsLoading  = ref(false)
const locks      = ref([]);   const locksLoading  = ref(false)
const healthDetail = ref(null); const healthDetailLoading = ref(false)
// [dxc][2026-10-08][新增] 深度监控摘要状态 — 原因：深度监控 Tab 数据
const phase2Loading = ref(false)
const phase2Metrics = ref([])
const phase2Summary = ref(null)
const phase2CollectedAt = ref(null)
// [dxc][2026-10-08][新增] 主机 SSH 状态
const hostMetrics = ref([])
const hostSummary = ref(null)

const isOracle = computed(() => basic.value?.DB_TYPE === 'ORACLE')
// [dxc][2026-10-08][新增] 仅 Oracle/磐维展示深度监控 Tab
const showEnginePhase2 = computed(() => ['ORACLE', 'PANWEI'].includes(basic.value?.DB_TYPE))

const sessChartRef = ref(); const cpuChartRef = ref(); const connChartRef = ref()
const waitClassChartRef = ref(); const waitEventChartRef = ref()
// 离开页面时释放全部 ECharts 实例（原来没有 onBeforeUnmount，反复进出实例详情页内存持续增长）
onBeforeUnmount(() => {
  for (const r of [sessChartRef, cpuChartRef, connChartRef, waitClassChartRef, waitEventChartRef]) {
    const el = r.value
    if (el) echarts.getInstanceByDom(el)?.dispose()
  }
})

const tsFootnote = computed(() => {
  if (tsError.value) return `表空间读取失败：${tsError.value}`
  if (tablespaces.value.some(r => r.DEGRADED === 'NAMES_ONLY')) {
    return '当前只能列出表空间名，容量数据不可用：19c 的 dba_tablespace_usage_metrics 与 legacy 的 dba_data_files/dba_free_space 均不可读。请给被管账号授予 SELECT ANY DICTIONARY（或 SELECT_CATALOG_ROLE 并单独授权），详见 docs/monitor-target-db-privileges.md'
  }
  const t = basic.value?.DB_TYPE
  if (t === 'MYSQL' || t === 'GOLDENDB') {
    return 'MySQL/GoldenDB：按账号可见的 schema 汇总容量；无全局 SELECT 时通常只显示本库。被管账号需 PROCESS + performance_schema，详见 docs/monitor-target-db-privileges.md'
  }
  if (t === 'PANWEI') {
    return '磐维：按表空间展示。已设置 MAXSIZE 时使用率 = 已用 / 上限；未设置上限时不计算使用率。'
  }
  if (t === 'POSTGRESQL') {
    return 'PostgreSQL：按 database 展示；需对各库 CONNECT 及统计视图权限，否则仅当前库。'
  }
  if (t === 'SQLSERVER') return 'SQL Server：展示当前连接库的数据文件占用。'
  if (t === 'ORACLE') {
    return 'Oracle：被管账号建议授予 SELECT ANY DICTIONARY、SELECT ANY TRANSACTION 等（见 docs/monitor-target-db-privileges.md）；否则可能只能看到本 schema 或表空间为空。'
  }
  if (t === 'DAMENG') return '达梦：依赖 V$/字典视图；权限不足时表空间或容量项可能为空。'
  return ''
})

function isSessActive(status) {
  const s = String(status || '').toUpperCase()
  return s === 'ACTIVE' || s === 'QUERY' || s === 'RUNNING'
}

// 关键指标卡片（按库类型取对应指标）
const keyMetrics = computed(() => {
  const m = perf.value?.metrics || []
  const get = (name) => m.find((r) => r.METRIC_NAME === name)?.VALUE
  const engine = (perf.value?.exporter?.engine || basic.value?.DB_TYPE || '').toUpperCase()

  if (engine === 'ORACLE') {
    const bufHit = get('Buffer Cache Hit Ratio')
    return [
      { name: 'Buffer Cache命中率', val: bufHit != null ? bufHit.toFixed(1) : '-', unit: '%',
        alertClass: bufHit != null && bufHit < 95 ? 'metric-warn' : '' },
      { name: '活跃会话数', val: get('Active Sessions') ?? '-', unit: '个', alertClass: '' },
      { name: '每秒用户调用', val: get('User Calls Per Sec')?.toFixed(1) ?? '-', unit: '/s', alertClass: '' },
      { name: 'Shared Pool空闲', val: get('Shared Pool Free %')?.toFixed(1) ?? '-', unit: '%', alertClass: '' },
    ]
  }
  if (engine === 'MYSQL') {
    const hit = get('mysql_innodb_buffer_pool_hit_ratio')
    return [
      { name: 'InnoDB 缓冲命中率', val: hit != null ? hit.toFixed(1) : '-', unit: '%',
        alertClass: hit != null && hit < 95 ? 'metric-warn' : '' },
      { name: 'Threads_connected', val: get('mysql_global_status_threads_connected') ?? '-', unit: '', alertClass: '' },
      { name: 'Threads_running', val: get('mysql_global_status_threads_running') ?? '-', unit: '', alertClass: '' },
      { name: '慢查询累计', val: get('mysql_global_status_slow_queries') ?? '-', unit: '', alertClass: '' },
    ]
  }
  if (engine === 'POSTGRESQL' || engine === 'PANWEI') {
    const hit = get('pg_buffer_cache_hit_ratio')
    return [
      { name: '缓冲命中率(估算)', val: hit != null ? hit.toFixed(1) : '-', unit: '%',
        alertClass: hit != null && hit < 95 ? 'metric-warn' : '' },
      { name: '后端连接数', val: get('pg_stat_database_numbackends') ?? '-', unit: '', alertClass: '' },
      { name: '事务提交', val: get('pg_stat_database_xact_commit') ?? '-', unit: '', alertClass: '' },
      { name: '事务回滚', val: get('pg_stat_database_xact_rollback') ?? '-', unit: '', alertClass: '' },
    ]
  }
  if (engine === 'SQLSERVER') {
    const hit = get('mssql_buffer_cache_hit_ratio')
    return [
      { name: 'Buffer Cache命中率', val: hit != null ? hit.toFixed(1) : '-', unit: '%',
        alertClass: hit != null && hit < 95 ? 'metric-warn' : '' },
      { name: '用户连接数', val: get('mssql_user_connections') ?? '-', unit: '', alertClass: '' },
      { name: '活跃会话', val: get('mssql_active_sessions') ?? '-', unit: '', alertClass: '' },
      { name: 'Page Life Expectancy', val: get('mssql_page_life_expectancy') ?? '-', unit: 's', alertClass: '' },
    ]
  }
  if (engine === 'DAMENG') {
    const bufHit = get('Buffer Cache Hit Ratio')
    return [
      { name: 'Buffer Cache命中率', val: bufHit != null ? bufHit.toFixed(1) : '-', unit: '%',
        alertClass: bufHit != null && bufHit < 95 ? 'metric-warn' : '' },
      { name: '活跃会话数', val: get('Active Sessions') ?? '-', unit: '个', alertClass: '' },
      { name: '当前登录数', val: get('Current Logons Count') ?? '-', unit: '个', alertClass: '' },
      { name: 'Shared Pool空闲', val: get('Shared Pool Free %')?.toFixed(1) ?? '-', unit: '%', alertClass: '' },
    ]
  }
  return [
    { name: '—', val: '-', unit: '', alertClass: '' },
    { name: '—', val: '-', unit: '', alertClass: '' },
    { name: '—', val: '-', unit: '', alertClass: '' },
    { name: '—', val: '-', unit: '', alertClass: '' },
  ]
})

// [dxc][2026-10-08][新增] engineMetrics 卡片展示（中文标签 + 简单告警色）
const PHASE2_LABELS = {
  oracle_blocking_session_max_sec: '阻塞最大等待',
  oracle_blocking_session_over_60s: '阻塞>60s会话数',
  oracle_alert_ora_00060_24h: 'ORA-00060(24h)',
  oracle_alert_ora_4031_24h: 'ORA-4031(24h)',
  oracle_log_file_sync_ms: 'Log File Sync',
  oracle_rman_full_backup_hours_ago: 'RMAN全备(小时前)',
  oracle_fra_used_pct: 'FRA使用率',
  panwei_idle_in_txn_over_5min: 'idle in txn>5min',
  panwei_lock_wait_count: '锁等待数',
  panwei_replication_lag_bytes: '复制延迟(B)',
  panwei_replication_not_streaming_count: '非Streaming复制',
  panwei_top_sql_mean_ms: 'TOP SQL均耗时',
  panwei_wal_file_count: 'WAL文件数',
  panwei_tables_high_dead_tup: '高dead tuple表数',
}

const HOST_LABELS = {
  host_cpu_used_pct: '主机 CPU',
  host_mem_used_pct: '主机内存',
  host_load_1m: '1分钟负载',
  host_fs_used_pct_max: '磁盘最大使用率',
  host_listener_ready: '监听器就绪',
  host_crs_resource_offline: 'CRS离线资源数',
  host_ora_background_proc_count: 'ora_ 进程数',
  panwei_gs_om_cluster_abnormal: 'gs_om集群异常',
  host_ssh_ok: 'SSH可达',
}

const hostSkipHint = computed(() => {
  const s = hostSummary.value?.skip
  if (s === 'ssh_not_configured') return 'SSH 未启用或未配置凭据'
  if (s === 'no_host_id') return '实例未绑定 CMDB HOST_ID'
  return s || '未知'
})

const hostRawExcerpt = computed(() => {
  const h = hostSummary.value
  if (!h) return ''
  return [h.listener?.excerpt, h.crs?.excerpt, h.gsOm?.excerpt, h.gsCtlExcerpt].filter(Boolean).join('\n---\n')
})

const hostMetricCards = computed(() => {
  const rows = hostMetrics.value || []
  return rows
    .filter((r) => r.key && !String(r.key).startsWith('_'))
    .map((r) => {
      const v = Number(r.value)
      let alertClass = ''
      if (r.key === 'host_cpu_used_pct' && v > 85) alertClass = 'metric-warn'
      if (r.key === 'host_fs_used_pct_max' && v >= 85) alertClass = 'metric-warn'
      if (r.key === 'host_listener_ready' && v < 1) alertClass = 'metric-warn'
      if (r.key === 'panwei_gs_om_cluster_abnormal' && v > 0) alertClass = 'metric-warn'
      return {
        key: r.key,
        label: HOST_LABELS[r.key] || r.key,
        val: Number.isFinite(v) ? String(Math.round(v * 100) / 100) : (r.value === 1 ? '是' : r.value === 0 ? '否' : '-'),
        unit: r.unit || '',
        alertClass,
      }
    })
})

const phase2MetricCards = computed(() => {
  const rows = phase2Metrics.value || []
  return rows
    .filter((r) => r.key && !String(r.key).startsWith('_'))
    .slice(0, 12)
    .map((r) => {
      const v = Number(r.value)
      let alertClass = ''
      if (r.key.includes('ora_00060') || r.key.includes('ora_4031') || r.key === 'oracle_blocking_session_over_60s') {
        if (v > 0) alertClass = 'metric-warn'
      }
      if (r.key === 'panwei_replication_not_streaming_count' && v > 0) alertClass = 'metric-warn'
      return {
        key: r.key,
        label: PHASE2_LABELS[r.key] || r.key,
        val: Number.isFinite(v) ? (v >= 1000 && r.unit === 'bytes' ? (v / 1048576).toFixed(1) : String(Math.round(v * 100) / 100)) : '-',
        unit: r.unit === 'bytes' && v >= 1000 ? 'MB' : (r.unit || ''),
        alertClass,
      }
    })
})

function statusLabel(s) { return { RUNNING:'运行中', STOPPED:'已停止', ERROR:'异常', UNKNOWN:'未知' }[s] || s }
function dbTypeColor(t) { return { ORACLE:'danger', MYSQL:'primary', POSTGRESQL:'success', PANWEI:'success', SQLSERVER:'warning' }[t] || 'info' }
function scoreClass(s)  { return s >= 90 ? 'score-high' : s >= 60 ? 'score-medium' : 'score-low' }
function gradeKey(s) { return s == null ? 'UNKNOWN' : s >= 90 ? 'HEALTHY' : s >= 60 ? 'ATTENTION' : 'CRITICAL' }
function alertStatusType(s) { return { OPEN:'danger', ACKNOWLEDGED:'warning', RESOLVED:'success' }[s] || 'info' }
function alertStatusLabel(s) { return { OPEN:'未处理', ACKNOWLEDGED:'已确认', RESOLVED:'已解决', SUPPRESSED:'已抑制' }[s] || s }
function fmt(v) { return v ? new Date(v).toLocaleString('zh-CN') : '-' }
function scoreStyle(score) {
  const color = score == null ? '#8c8c8c' : score >= 90 ? '#52c41a' : score >= 60 ? '#faad14' : '#ff4d4f'
  return { '--score-color': color }
}

async function loadBasic() {
  basicLoading.value = true
  try {
    const [b, s] = await Promise.all([monitorApi.basic(id.value), monitorApi.sysinfo(id.value).catch(()=>({code:0}))])
    basic.value   = b.data
    sysinfo.value = s.code === 200 ? s.data : null
    const sec = Number(basic.value?.COLLECT_INTERVAL_SEC)
    collectIntervalMin.value = Number.isFinite(sec) && sec > 0 ? Math.round(sec / 60) : 0
  } finally { basicLoading.value = false }
}

// [dxc][2026-10-17][新增] 立即采集 + 本实例采集间隔
async function runCollectNow() {
  collectingNow.value = true
  try {
    const r = await monitorApi.collectNow(id.value)
    if (r.code !== 200) {
      ElMessage.error(r.msg || '采集失败')
      return
    }
    ElMessage.success(r.msg || (r.data?.ok ? '采集已入库' : '采集完成'))
    await loadBasic()
    await loadHealthDetail()
    refreshCurrent()
  } catch (e) {
    ElMessage.error(e?.message || '采集失败')
  } finally {
    collectingNow.value = false
  }
}

async function saveCollectSchedule() {
  const min = Number(collectIntervalMin.value) || 0
  const intervalSec = min <= 0 ? 0 : Math.max(60, Math.round(min * 60))
  savingCollectSchedule.value = true
  try {
    const r = await monitorApi.setCollectSchedule(id.value, { intervalSec })
    if (r.code !== 200) {
      ElMessage.error(r.msg || '保存失败')
      return
    }
    ElMessage.success(r.msg || '已保存')
    await loadBasic()
  } catch (e) {
    ElMessage.error(e?.message || '保存失败')
  } finally {
    savingCollectSchedule.value = false
  }
}

async function loadHealthDetail() {
  healthDetailLoading.value = true
  try {
    const r = await monitorApi.healthDetail(id.value)
    healthDetail.value = r.data
    await nextTick()
  } catch { healthDetail.value = null }
  healthDetailLoading.value = false
}

function scoreDimColor(s) { return s >= 90 ? '#52c41a' : s >= 60 ? '#faad14' : '#ff4d4f' }

async function loadPerf() {
  perfLoading.value = true
  try {
    const [p, w] = await Promise.all([monitorApi.performance(id.value), monitorApi.waits(id.value).catch(()=>({data:[]}))])
    perf.value   = p.data || {}
    waitsData.value = w.data || []
    await nextTick(); initPerfCharts()
  } finally { perfLoading.value = false }
}

// [dxc][2026-10-08][新增] 加载深度监控摘要 — 原因：深度监控 Tab
async function loadEnginePhase2() {
  if (!showEnginePhase2.value) return
  phase2Loading.value = true
  try {
    const r = await monitorApi.enginePhase2(id.value)
    if (r.code !== 200) {
      phase2Metrics.value = []
      phase2Summary.value = null
      phase2CollectedAt.value = null
      return
    }
    phase2Metrics.value = r.data?.engineMetrics || []
    phase2Summary.value = r.data?.enginePhase2Summary || null
    phase2CollectedAt.value = r.data?.collectedAt || null
    hostMetrics.value = r.data?.hostMetrics || []
    hostSummary.value = r.data?.hostSummary || null
  } catch (e) {
    phase2Metrics.value = []
    phase2Summary.value = null
    hostMetrics.value = []
    hostSummary.value = null
    ElMessage.error(e?.message || '加载深度监控失败')
  } finally {
    phase2Loading.value = false
  }
}

async function loadTablespaces() {
  tsLoading.value = true
  tsError.value = ''
  try {
    const r = await monitorApi.tablespaces(id.value)
    tablespaces.value = r.data || []
    if (!tablespaces.value.length) {
      ElMessage.warning('表空间列表为空，请检查被管库账号是否有 DBA_/ALL_ 或 schema 查询权限')
    }
  } catch (e) {
    tablespaces.value = []
    tsError.value = e?.message || '加载表空间失败，多为被管账号权限不足'
    ElMessage.error(tsError.value)
  } finally { tsLoading.value = false }
}

// ── 运行自检 ────────────────────────────────────────────────────
// Java 网关是 /api/monitor 的实际提供方；若部署的是旧 jar（无 tablespace-diagnostics），
// 自动回退到 Node 侧同构的 /api/diagnostics/target/:id，保证自检按钮始终可用。
async function runTargetDiag() {
  diagLoading.value = true
  try {
    let r
    try {
      r = await monitorApi.tablespaceDiagnostics(id.value)
    } catch (e) {
      const msg = String(e?.message || '')
      if (!/接口不存在|404|Not Found|405|Method Not Allowed|503/i.test(msg)) throw e
      r = await diagnosticsApi.target(id.value)
    }
    diagResult.value = r?.data || r || null
  } catch (e) {
    diagResult.value = null
    ElMessage.error('自检失败：' + (e?.message || e))
  } finally { diagLoading.value = false }
}

function openDiag() {
  diagVisible.value = true
  diagResult.value = null
  runTargetDiag()
}

async function runExtraDiag(kind) {
  diagExtraLoading.value = true
  try {
    const r = kind === 'routes' ? await diagnosticsApi.routes() : await diagnosticsApi.reports()
    diagExtraText.value = JSON.stringify(r?.data ?? r, null, 2)
    diagExtraVisible.value = true
  } catch (e) {
    ElMessage.error('自检失败：' + (e?.message || e))
  } finally { diagExtraLoading.value = false }
}


async function loadSessions() {
  sessLoading.value = true
  try {
    const r = await monitorApi.sessions(id.value, { onlyActive: onlyActive.value ? '1' : '0' })
    sessions.value = r.data || []
  } finally { sessLoading.value = false }
}

async function loadAlerts() {
  alertsLoading.value = true
  try { const r = await monitorApi.alerts(id.value); instAlerts.value = r.data || [] }
  finally { alertsLoading.value = false }
}

async function loadAwr() {
  awrLoading.value = true
  try { const r = await monitorApi.awrSnapshots(id.value); awrSnaps.value = r.data || [] }
  finally { awrLoading.value = false }
}

async function loadAudit() {
  auditLoading.value = true
  try { const r = await monitorApi.audit(id.value); auditLogs.value = r.data || [] }
  finally { auditLoading.value = false }
}

async function loadWaits() {
  waitsLoading.value = true
  try {
    const r = await monitorApi.waits(id.value)
    allWaits.value = r.data || []
    await nextTick(); initWaitCharts()
  } catch (e) { allWaits.value = []; ElMessage.error(e?.message || '加载等待事件失败') }
  finally { waitsLoading.value = false }
}

async function loadLocks() {
  locksLoading.value = true
  try {
    const r = await monitorApi.locks(id.value)
    locks.value = r.data || []
  } catch (e) { locks.value = []; ElMessage.error(e?.message || '加载锁信息失败') }
  finally { locksLoading.value = false }
}

function fmtTrendAxis(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  if (trendRange.value === '7d' || trendRange.value === '1d') {
    return `${d.getMonth() + 1}/${d.getDate()} ${h}:${m}`
  }
  return `${h}:${m}`
}

async function loadTrend() {
  await nextTick()
  let series = []
  try {
    const r = await monitorApi.trend(id.value, { range: trendRange.value })
    if (r.code === 200) series = r.data?.series || []
  } catch {
    series = []
  }
  const labels = series.length ? series.map((s) => fmtTrendAxis(s.t)) : ['—']
  const cpuData = series.length ? series.map((s) => (s.cpu != null && Number.isFinite(s.cpu) ? s.cpu : null)) : [null]
  const connData = series.length ? series.map((s) => (s.conn != null && Number.isFinite(s.conn) ? s.conn : null)) : [null]
  ;[cpuChartRef, connChartRef].forEach((ref, i) => {
    if (!ref.value) return
    const c = echarts.getInstanceByDom(ref.value) || echarts.init(ref.value)
    const isCpu = i === 0
    const data = isCpu ? cpuData : connData
    const hasData = data.some((v) => v != null)
    c.setOption({
      backgroundColor: 'transparent',
      textStyle: { color: '#909399' },
      title: {
        text: isCpu ? '负载/CPU 相关指标趋势' : '连接数趋势',
        subtext: !hasData ? '暂无样本，等待周期采集或点击刷新' : '',
        textStyle: { fontSize: 13, color: '#303133' },
        subtextStyle: { fontSize: 11, color: '#b0b3b8' },
      },
      tooltip: { trigger: 'axis' },
      grid: { left: 48, right: 16, top: hasData ? 36 : 52, bottom: 24 },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { color: '#909399' },
        axisLine: { lineStyle: { color: '#e4e7ed' } },
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLabel: { color: '#909399' },
        splitLine: { lineStyle: { color: '#e4e7ed' } },
      },
      series: [{
        type: 'line',
        smooth: true,
        data,
        connectNulls: true,
        areaStyle: { opacity: 0.1 },
        itemStyle: { color: isCpu ? '#1890ff' : '#52c41a' },
      }],
    })
  })
}

function initPerfCharts() {
  if (!sessChartRef.value) return
  const c = echarts.getInstanceByDom(sessChartRef.value) || echarts.init(sessChartRef.value)
  const sessData = perf.value?.sessions || []
  const activeCount  = sessData.find(s => String(s.STATUS).toUpperCase() === 'ACTIVE')?.CNT || 0
  const inactiveCount= sessData.find(s => String(s.STATUS).toUpperCase() === 'INACTIVE')?.CNT || 0
  c.setOption({
    backgroundColor: 'transparent',
    textStyle: { color: '#909399' },
    tooltip: { trigger: 'item' },
    legend: { bottom: 0, textStyle: { color: '#909399' } },
    series: [{
      type: 'pie', radius: ['45%','70%'], center: ['50%','45%'],
      data: [
        { name: `活跃 (${activeCount})`,   value: activeCount,   itemStyle: { color: '#ff4d4f' } },
        { name: `非活跃 (${inactiveCount})`, value: inactiveCount, itemStyle: { color: '#1890ff' } },
      ],
    }],
  })
}

async function killSess(row) {
  try {
    const r = await monitorApi.killSession(id.value, { sid: row.SID, serial: row['SERIAL#'] })
    ElMessage.success(r.msg || '会话已终止')
    loadSessions()
  } catch (e) { ElMessage.error(e.message) }
}


function waitClassColor(cls) {
  const map = { 'User I/O': 'primary', 'System I/O': 'primary', 'Concurrency': 'danger', 'Application': 'warning',
    'Commit': 'success', 'Configuration': 'info', 'Network': '', 'Cluster': 'warning', 'Scheduler': 'info',
    'Administrative': 'danger', 'Queueing': 'warning', 'Other': 'info' }
  return map[cls] || 'info'
}

function initWaitCharts() {
  const data = allWaits.value
  if (!data.length) return
  // 按等待类汇总
  const classMap = {}
  data.forEach(w => {
    const cls = w.WAIT_CLASS || 'Other'
    if (!classMap[cls]) classMap[cls] = 0
    classMap[cls] += w.TIME_WAITED_SEC || 0
  })
  const classData = Object.entries(classMap).map(([name, value]) => ({ name, value: Math.round(value * 100) / 100 }))
    .sort((a, b) => b.value - a.value)

  const colorPalette = ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452', '#9a60b4', '#ea7ccc']
  // 饼图 - 等待类分布
  if (waitClassChartRef.value) {
    const c = echarts.getInstanceByDom(waitClassChartRef.value) || echarts.init(waitClassChartRef.value)
    c.setOption({
      backgroundColor: 'transparent', tooltip: { trigger: 'item', formatter: '{b}: {c}s ({d}%)' },
      color: colorPalette,
      series: [{ type: 'pie', radius: ['40%', '70%'], center: ['50%', '55%'], avoidLabelOverlap: true,
        itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 2 },
        label: { show: true, fontSize: 11 },
        data: classData }],
    })
  }
  // 横向柱状图 - Top 10 等待事件
  const top10 = data.slice(0, 10).reverse()
  if (waitEventChartRef.value) {
    const c = echarts.getInstanceByDom(waitEventChartRef.value) || echarts.init(waitEventChartRef.value)
    c.setOption({
      backgroundColor: 'transparent', tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 16, right: 40, top: 8, bottom: 24, containLabel: true },
      xAxis: { type: 'value', name: '秒', axisLabel: { color: '#909399', fontSize: 11 }, splitLine: { lineStyle: { color: '#e4e7ed' } } },
      yAxis: { type: 'category', data: top10.map(w => w.EVENT?.length > 28 ? w.EVENT.slice(0, 28) + '…' : w.EVENT),
        axisLabel: { color: '#606266', fontSize: 11 } },
      series: [{ type: 'bar', barWidth: 16, data: top10.map(w => w.TIME_WAITED_SEC || 0),
        itemStyle: { color: (p) => colorPalette[p.dataIndex % colorPalette.length], borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: 'right', fontSize: 11, color: '#606266', formatter: '{c}s' } }],
    })
  }
}

const awrReportRange = ref('')

function genAwr(format = 'html') {
  const sorted = [...awrSel.value].sort((a, b) => Number(a.SNAP_ID) - Number(b.SNAP_ID))
  if (sorted.length < 2) return
  const beginSnap = Number(sorted[0].SNAP_ID)
  const endSnap = Number(sorted[sorted.length - 1].SNAP_ID)
  const fmt = format === 'text' ? 'text' : 'html'
  awrReportLoading.value = true
  awrReportRange.value = `${beginSnap} → ${endSnap}`
  monitorApi.awrReport(id.value, {
    beginSnap,
    endSnap,
    dbid: sorted[0].DBID,
    instanceNumber: sorted[0].INSTANCE_NUMBER,
    format: fmt,
  })
    .then((r) => {
      awrReportFormat.value = r.data?.format || fmt
      awrReportContent.value = r.data?.report || ''
      awrReportVisible.value = true
      if (!awrReportContent.value) ElMessage.warning('报告为空，请确认 AWR 权限与快照区间')
      else {
        const label = awrReportFormat.value === 'html' ? 'HTML' : '文本'
        ElMessage.success(`${label} AWR 已生成（快照 ${awrReportRange.value}）`)
      }
    })
    .catch((e) => ElMessage.error(e?.message || 'AWR 报告生成失败'))
    .finally(() => { awrReportLoading.value = false })
}

function downloadAwrReport() {
  if (!awrReportContent.value) return
  const isHtml = awrReportFormat.value === 'html'
  const blob = new Blob(
    [awrReportContent.value],
    { type: isHtml ? 'text/html;charset=utf-8' : 'text/plain;charset=utf-8' }
  )
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  const ext = isHtml ? 'html' : 'txt'
  a.download = `awr_${basic.value?.INSTANCE_NAME || id.value}_${awrReportRange.value.replace(/\s→\s/g, '-')}.${ext}`
  a.click()
  URL.revokeObjectURL(a.href)
}

function onTabChange(tab) {
  const name = tab.paneName
  if (name === 'perf' && !perf.value.metrics) loadPerf()
  else if (name === 'engine-phase2') loadEnginePhase2()
  else if (name === 'tablespaces' && !tablespaces.value.length) loadTablespaces()
  else if (name === 'sessions' && !sessions.value.length) loadSessions()
  else if (name === 'alerts' && !instAlerts.value.length) loadAlerts()
  else if (name === 'trend') loadTrend()
  else if (name === 'waits') loadWaits()
  else if (name === 'locks') loadLocks()
  else if (name === 'awr' && !awrSnaps.value.length) loadAwr()
  else if (name === 'audit' && !auditLogs.value.length) loadAudit()
}

function refreshCurrent() {
  const loaders = { basic: loadBasic, perf: loadPerf, 'engine-phase2': loadEnginePhase2, tablespaces: loadTablespaces,
    sessions: loadSessions, alerts: loadAlerts, trend: loadTrend, waits: loadWaits, locks: loadLocks, awr: loadAwr, audit: loadAudit }
  loaders[activeTab.value]?.()
}

onMounted(async () => {
  await loadBasic()
  await loadHealthDetail()
})
</script>

<style scoped>
.ts-actions { display: flex; gap: 8px; }
.diag-meta { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12px; color: var(--agent-text-muted, #909399); margin-bottom: 12px; }
.diag-err { color: #ff4d4f; }
.diag-footer { display: flex; align-items: center; gap: 8px; }
.diag-spacer { flex: 1; }
.diag-json { max-height: 60vh; overflow: auto; background: var(--agent-bg-soft, #f6f8fa); padding: 12px; border-radius: 6px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; }

.detail-header { display: flex; justify-content: space-between; align-items: center; }
.dh-title { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.inst-name { font-size: 20px; font-weight: 700; color: var(--agent-text, #303133); }
.status-chip { font-size: 14px; }
.dh-meta { display: flex; align-items: center; gap: 16px; color: var(--agent-text-muted, #909399); font-size: 13px; }
.dh-meta .el-icon { margin-right: 2px; }
.dh-right { display: flex; align-items: center; gap: 20px; }
.dh-actions { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
.collect-schedule-pop { padding: 4px 0; }
.mt-12 { margin-top: 12px; }
.mb-8 { margin-bottom: 8px; }

.score-circle {
  width: 80px; height: 80px; border-radius: 50%;
  border: 4px solid var(--score-color, #52c41a);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
}
.score-num { font-size: 22px; font-weight: 700; color: var(--score-color, #52c41a); }
.score-text { font-size: 11px; color: #b0b3b8; }

.detail-tabs { background: transparent; }
.detail-tabs :deep(.el-tabs__header) { margin-bottom: 0; }
.detail-tabs :deep(.el-tabs__content) { padding: 0; }

.metric-card {
  background: var(--agent-panel-deep, #f5f7fa);
  border-radius: 8px;
  padding: 16px;
  text-align: center;
  border: 1px solid var(--agent-border, #e4e7ed);
  transition: all .2s;
}
.metric-card.metric-warn { border-color: #faad14; background: rgba(250, 173, 20, 0.12); }
.metric-val  { font-size: 28px; font-weight: 700; color: var(--agent-text, #303133); }
.metric-name { font-size: 13px; color: var(--agent-text-muted, #909399); margin-top: 4px; }
.metric-unit { font-size: 12px; color: var(--agent-text-tertiary, #b0b3b8); }
.mt-12 { margin-top: 12px; }
.mr-8 { margin-right: 8px; }
.flex-center { display: flex; align-items: center; }
.gap-8 { gap: 8px; }
.awr-report-iframe {
  width: 100%;
  height: 72vh;
  border: 1px solid var(--agent-border, #e4e7ed);
  border-radius: 6px;
  background: #fff;
}
.awr-report-pre {
  max-height: 70vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.45;
  margin: 0;
  padding: 12px;
  background: var(--agent-panel-deep, #f5f7fa);
  border-radius: 6px;
}

.sub-title { font-size: 14px; font-weight: 600; margin-bottom: 8px; color: var(--agent-text, #303133); }
.exporter-help { display: block; margin-top: 6px; font-size: 12px; color: var(--agent-text-muted, #909399); font-weight: normal; }
.text-muted { color: var(--agent-text-tertiary, #b0b3b8); font-size: 12px; }

/* Lock chain */
.lock-chain { display: flex; flex-direction: column; gap: 12px; }
.lock-chain-item { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: var(--agent-panel-deep, #f5f7fa); border-radius: 8px; border: 1px solid var(--agent-border, #e4e7ed); flex-wrap: wrap; }
.lock-node { display: flex; flex-direction: column; min-width: 160px; border-radius: 6px; overflow: hidden; }
.lock-node-title { font-size: 11px; font-weight: 600; padding: 4px 10px; text-align: center; color: #fff; }
.lock-holder .lock-node-title { background: #F56C6C; }
.lock-waiter .lock-node-title { background: #E6A23C; }
.lock-node-body { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; background: #fff; font-size: 12px; }
.lock-sid { font-weight: 700; color: var(--agent-text, #303133); }
.lock-user { color: var(--agent-text-muted, #909399); }
.lock-prog { color: var(--agent-text-tertiary, #b0b3b8); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
.lock-arrow { display: flex; flex-direction: column; align-items: center; gap: 2px; flex-shrink: 0; }
.lock-wait-info { font-size: 11px; color: var(--agent-text-muted, #909399); white-space: nowrap; }
.lock-event-tag { margin-left: auto; }
.host-raw { font-size: 11px; max-height: 240px; overflow: auto; white-space: pre-wrap; background: var(--agent-panel-deep, #f5f7fa); padding: 12px; border-radius: 6px; }
.text-danger { color: #ff4d4f; font-weight: 600; }
.text-warn { color: #faad14; font-weight: 600; }
.health-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.h-grade { font-size: 13px; padding: 2px 10px; border-radius: 10px; font-weight: 600; }
.h-score { font-size: 30px; font-weight: 700; line-height: 1; }
.h-sub { font-weight: 600; margin-bottom: 8px; color: #303133; }
.h-cat { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px dashed #f0f0f0; font-size: 13px; }
.h-cat-label { width: 70px; color: #595959; flex-shrink: 0; }
.h-cat-detail { color: #262626; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.h-pill { font-size: 11px; padding: 0 6px; border-radius: 3px; flex-shrink: 0; border: 1px solid transparent; }
.h-pill.OK { background: #f6ffed; color: #389e0d; border-color: #b7eb8f; }
.h-pill.WARN { background: #fffbe6; color: #d48806; border-color: #ffe58f; }
.h-pill.CRIT { background: #fff1f0; color: #cf1322; border-color: #ffa39e; }
.h-pill.NA { background: #fafafa; color: #8c8c8c; border-color: #f0f0f0; }
.h-ok { color: #389e0d; background: #f6ffed; padding: 10px; border-radius: 6px; font-size: 13px; }
.rules { margin: 0; padding-left: 18px; line-height: 1.7; font-size: 13px; color: #434343; }
</style>
