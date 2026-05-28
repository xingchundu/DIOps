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
        <div class="score-circle" :style="scoreStyle(basic.HEALTH_SCORE)">
          <div class="score-num">{{ basic.HEALTH_SCORE }}</div>
          <div class="score-text">健康分</div>
        </div>
        <div class="dh-actions">
          <el-badge v-if="basic.OPEN_ALERTS > 0" :value="basic.OPEN_ALERTS" type="danger">
            <el-button size="small" type="danger" plain @click="activeTab='alerts'">未处理告警</el-button>
          </el-badge>
          <el-button size="small" icon="Refresh" @click="refreshCurrent">刷新</el-button>
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
              </el-descriptions>
            </el-col>
            <el-col :span="12">
              <div class="card-title">数据库实例信息（Exporter 拉取）</div>
              <el-descriptions :column="1" border size="small" v-if="sysinfo.instance">
                <el-descriptions-item label="实例名">{{ sysinfo.instance.INSTANCE_NAME }}</el-descriptions-item>
                <el-descriptions-item label="版本">{{ sysinfo.instance.VERSION }}</el-descriptions-item>
                <el-descriptions-item label="启动时间">{{ sysinfo.instance.STARTUP_TIME }}</el-descriptions-item>
                <el-descriptions-item label="状态">{{ sysinfo.instance.STATUS }}</el-descriptions-item>
                <el-descriptions-item label="数据库角色">{{ sysinfo.database?.DATABASE_ROLE }}</el-descriptions-item>
                <el-descriptions-item label="日志模式">{{ sysinfo.database?.LOG_MODE }}</el-descriptions-item>
                <el-descriptions-item label="开库模式">{{ sysinfo.database?.OPEN_MODE }}</el-descriptions-item>
                <el-descriptions-item label="DB唯一名">{{ sysinfo.database?.DB_UNIQUE_NAME }}</el-descriptions-item>
                <el-descriptions-item label="健康评分">
                  <span :class="scoreClass(basic.HEALTH_SCORE)" style="font-size:18px">{{ basic.HEALTH_SCORE }}</span>
                </el-descriptions-item>
              </el-descriptions>
              <el-empty v-else description="实例信息获取失败（检查 CMDB 连接串与账号权限）" />
            </el-col>
          </el-row>
          <!-- 多维度健康评分 -->
          <el-divider content-position="left">多维度健康评分</el-divider>
          <el-row :gutter="24" v-if="healthDetail?.dimensions">
            <el-col :span="10">
              <div ref="healthRadarRef" style="height:260px"></div>
            </el-col>
            <el-col :span="14">
              <div v-for="dimKey in ['connectivity','performance','load','resource']" :key="dimKey"
                   style="margin-bottom:16px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                  <span style="font-size:13px;font-weight:600;color:#303133">
                    {{ healthDetail.dimensions[dimKey]?.label || dimKey }}
                    <el-tag size="small" type="info" style="margin-left:4px">权重 {{ healthDetail.dimensions[dimKey]?.weight }}%</el-tag>
                  </span>
                  <span :style="{ color: scoreDimColor(healthDetail.dimensions[dimKey]?.score), fontWeight: 700, fontSize: '16px' }">
                    {{ healthDetail.dimensions[dimKey]?.score }}
                  </span>
                </div>
                <el-progress
                  :percentage="healthDetail.dimensions[dimKey]?.score || 0"
                  :color="scoreDimColor(healthDetail.dimensions[dimKey]?.score)"
                  :stroke-width="12"
                  :show-text="false"
                />
                <div style="font-size:11px;color:#909399;margin-top:2px">
                  {{ healthDetail.dimensions[dimKey]?.detail }}
                </div>
              </div>
            </el-col>
          </el-row>
          <el-empty v-else-if="!healthDetailLoading" description="暂无健康评分数据，请等待下次采集" />
        </div>
      </el-tab-pane>

      <!-- ② 实时性能 -->
      <el-tab-pane label="② 实时性能" name="perf">
        <div class="card" v-loading="perfLoading">
          <el-alert v-if="perf.exporter" type="success" :closable="false" show-icon class="mb-16">
            内置类 Exporter 拉取 · {{ perf.exporter.engine }} · {{ perf.exporter.scrape_ts }}
            <span class="exporter-help">{{ perf.exporter.help }}</span>
          </el-alert>
          <div class="card-title" style="justify-content:space-between">
            <span><el-icon><DataAnalysis /></el-icon> 关键指标仪表盘</span>
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

      <!-- ③ 表空间 -->
      <el-tab-pane label="③ 表空间" name="tablespaces">
        <div class="card" v-loading="tsLoading">
          <el-alert v-if="tsFootnote" type="info" :closable="false" class="mb-16">{{ tsFootnote }}</el-alert>
          <div class="card-title" style="justify-content:space-between">
            <span><el-icon><Coin /></el-icon> 表空间使用情况</span>
            <el-button size="small" icon="Refresh" @click="loadTablespaces">刷新</el-button>
          </div>
          <el-table :data="tablespaces" stripe border>
            <el-table-column prop="TABLESPACE_NAME" label="表空间名" min-width="150" />
            <el-table-column prop="TOTAL_GB" label="总大小(GB)" width="110" />
            <el-table-column prop="USED_GB" label="已用(GB)" width="110" />
            <el-table-column prop="FREE_GB" label="剩余(GB)" width="110" />
            <el-table-column label="使用率" min-width="160">
              <template #default="{ row }">
                <el-progress :percentage="row.USED_PCT || 0"
                  :color="row.USED_PCT>=90 ? '#ff4d4f' : row.USED_PCT>=80 ? '#faad14' : '#52c41a'"
                  :stroke-width="10" />
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>

      <!-- ④ SQL分析 -->
      <el-tab-pane label="④ SQL分析" name="sql">
        <div class="card" v-loading="sqlLoading">
          <div class="card-title" style="justify-content:space-between">
            <span><el-icon><Document /></el-icon> Top SQL（慢查询）</span>
            <el-select v-model="sqlOrderBy" size="small" style="width:130px" @change="loadTopSql">
              <el-option label="总耗时" value="elapsed" />
              <el-option label="执行次数" value="exec" />
              <el-option label="CPU时间" value="cpu" />
              <el-option label="逻辑读" value="buffer" />
            </el-select>
          </div>
          <el-table :data="topSql" stripe border size="small">
            <el-table-column prop="SQL_ID" label="SQL_ID" width="110" />
            <el-table-column prop="SQL_TEXT" label="SQL文本" min-width="300" show-overflow-tooltip />
            <el-table-column prop="EXECUTIONS" label="执行次数" width="90" />
            <el-table-column prop="AVG_ELAPSED_MS" label="均耗时(ms)" width="110" />
            <el-table-column prop="ELAPSED_TIME_TOTAL" label="总耗时(s)" width="100" />
            <el-table-column prop="PARSING_SCHEMA_NAME" label="Schema" width="100" />
            <el-table-column label="操作" width="80">
              <template #default="{ row }">
                <el-button link type="primary" @click="goSqlOpt(row.SQL_TEXT)">优化</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
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
          <el-alert type="info" :closable="false" show-icon style="margin-bottom:16px">
            曲线数据来自平台周期采集入库（默认约 90 秒一次，进入本页会立即触发一次采集）。部署 Prometheus Exporter 可与之并存做更细粒度指标。
          </el-alert>
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
          <el-alert type="info" :closable="false" class="mb-16">
            选择两个连续快照区间，生成AWR报告（需 SELECT_CATALOG_ROLE 权限）
          </el-alert>
          <el-table :data="awrSnaps" stripe border size="small" height="400"
            @selection-change="awrSel = $event" highlight-current-row>
            <el-table-column type="selection" width="50" />
            <el-table-column prop="SNAP_ID"     label="SNAP_ID" width="90" />
            <el-table-column prop="BEGIN_TIME"  label="开始时间" width="155" />
            <el-table-column prop="END_TIME"    label="结束时间" width="155" />
            <el-table-column prop="INSTANCE_NUMBER" label="实例号" width="80" />
          </el-table>
          <div style="margin-top:12px;text-align:right">
            <el-button type="primary" :disabled="awrSel.length < 2" @click="genAwr">生成AWR报告</el-button>
          </div>
        </div>
      </el-tab-pane>

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
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { monitorApi } from '@/api/index.js'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as echarts from 'echarts'

const route  = useRoute()
const router = useRouter()
const id     = computed(() => route.params.id)

const activeTab   = ref('basic')
const onlyActive  = ref(false)
const sqlOrderBy  = ref('elapsed')
const trendRange  = ref('1h')
const awrSel      = ref([])

// Data
const basic      = ref(null); const basicLoading  = ref(false)
const sysinfo    = ref(null)
const perf       = ref({});   const perfLoading   = ref(false)
const waitsData  = ref([])
const tablespaces= ref([]);   const tsLoading     = ref(false)
const topSql     = ref([]);   const sqlLoading    = ref(false)
const sessions   = ref([]);   const sessLoading   = ref(false)
const instAlerts = ref([]);   const alertsLoading = ref(false)
const awrSnaps   = ref([]);   const awrLoading    = ref(false)
const auditLogs  = ref([]);   const auditLoading  = ref(false)
const allWaits   = ref([]);   const waitsLoading  = ref(false)
const locks      = ref([]);   const locksLoading  = ref(false)
const healthDetail = ref(null); const healthDetailLoading = ref(false)

const isOracle = computed(() => basic.value?.DB_TYPE === 'ORACLE')

const sessChartRef = ref(); const cpuChartRef = ref(); const connChartRef = ref()
const waitClassChartRef = ref(); const waitEventChartRef = ref()
const healthRadarRef = ref()

const tsFootnote = computed(() => {
  const t = basic.value?.DB_TYPE
  if (t === 'MYSQL') return 'MySQL：按 schema 汇总 data+index 占用（近似表空间视图）。'
  if (t === 'POSTGRESQL') return 'PostgreSQL：按 database 展示占用（逻辑库级容量）。'
  return ''
})

function isSessActive(status) {
  const s = String(status || '').toUpperCase()
  return s === 'ACTIVE' || s === 'QUERY'
}

// Computed metrics cards（按 CMDB 库类型映射 Exporter 风格指标）
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
  if (engine === 'POSTGRESQL') {
    const hit = get('pg_buffer_cache_hit_ratio')
    return [
      { name: '缓冲命中率(估算)', val: hit != null ? hit.toFixed(1) : '-', unit: '%',
        alertClass: hit != null && hit < 95 ? 'metric-warn' : '' },
      { name: '后端连接数', val: get('pg_stat_database_numbackends') ?? '-', unit: '', alertClass: '' },
      { name: '事务提交', val: get('pg_stat_database_xact_commit') ?? '-', unit: '', alertClass: '' },
      { name: '事务回滚', val: get('pg_stat_database_xact_rollback') ?? '-', unit: '', alertClass: '' },
    ]
  }
  return [
    { name: '—', val: '-', unit: '', alertClass: '' },
    { name: '—', val: '-', unit: '', alertClass: '' },
    { name: '—', val: '-', unit: '', alertClass: '' },
    { name: '—', val: '-', unit: '', alertClass: '' },
  ]
})

function statusLabel(s) { return { RUNNING:'运行中', STOPPED:'已停止', ERROR:'异常', UNKNOWN:'未知' }[s] || s }
function dbTypeColor(t) { return { ORACLE:'danger', MYSQL:'primary', POSTGRESQL:'success' }[t] || 'info' }
function scoreClass(s)  { return s >= 80 ? 'score-high' : s >= 60 ? 'score-medium' : 'score-low' }
function alertStatusType(s) { return { OPEN:'danger', ACKNOWLEDGED:'warning', RESOLVED:'success' }[s] || 'info' }
function alertStatusLabel(s) { return { OPEN:'未处理', ACKNOWLEDGED:'已确认', RESOLVED:'已解决', SUPPRESSED:'已抑制' }[s] || s }
function fmt(v) { return v ? new Date(v).toLocaleString('zh-CN') : '-' }
function scoreStyle(score) {
  const color = score >= 80 ? '#52c41a' : score >= 60 ? '#faad14' : '#ff4d4f'
  return { '--score-color': color }
}

async function loadBasic() {
  basicLoading.value = true
  try {
    const [b, s] = await Promise.all([monitorApi.basic(id.value), monitorApi.sysinfo(id.value).catch(()=>({code:0}))])
    basic.value   = b.data
    sysinfo.value = s.code === 200 ? s.data : null
  } finally { basicLoading.value = false }
}

async function loadHealthDetail() {
  healthDetailLoading.value = true
  try {
    const r = await monitorApi.healthDetail(id.value)
    healthDetail.value = r.data
    await nextTick()
    initHealthRadar()
  } catch { healthDetail.value = null }
  healthDetailLoading.value = false
}

function scoreDimColor(s) { return s >= 80 ? '#52c41a' : s >= 60 ? '#faad14' : '#ff4d4f' }

function initHealthRadar() {
  if (!healthRadarRef.value || !healthDetail.value?.dimensions) return
  const dims = healthDetail.value.dimensions
  const keys = ['connectivity', 'performance', 'load', 'resource']
  const indicator = keys.map(k => ({ name: dims[k]?.label || k, max: 100 }))
  const values = keys.map(k => dims[k]?.score ?? 0)

  const c = echarts.getInstanceByDom(healthRadarRef.value) || echarts.init(healthRadarRef.value)
  c.setOption({
    backgroundColor: 'transparent',
    tooltip: {},
    radar: {
      indicator,
      radius: '65%',
      axisName: { color: '#606266', fontSize: 12 },
      splitArea: { areaStyle: { color: ['rgba(24,144,255,0.04)', 'rgba(24,144,255,0.08)'] } },
      splitLine: { lineStyle: { color: '#e4e7ed' } },
      axisLine: { lineStyle: { color: '#e4e7ed' } },
    },
    series: [{
      type: 'radar',
      data: [{
        value: values,
        name: '健康维度',
        areaStyle: { opacity: 0.2, color: '#1890ff' },
        lineStyle: { color: '#1890ff', width: 2 },
        itemStyle: { color: '#1890ff' },
      }],
    }],
  })
}

async function loadPerf() {
  perfLoading.value = true
  try {
    const [p, w] = await Promise.all([monitorApi.performance(id.value), monitorApi.waits(id.value).catch(()=>({data:[]}))])
    perf.value   = p.data || {}
    waitsData.value = w.data || []
    await nextTick(); initPerfCharts()
  } finally { perfLoading.value = false }
}

async function loadTablespaces() {
  tsLoading.value = true
  try { const r = await monitorApi.tablespaces(id.value); tablespaces.value = r.data || [] }
  finally { tsLoading.value = false }
}

async function loadTopSql() {
  sqlLoading.value = true
  try { const r = await monitorApi.topsql(id.value, { orderBy: sqlOrderBy.value }); topSql.value = r.data || [] }
  finally { sqlLoading.value = false }
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

function goSqlOpt(text) { router.push({ path: '/sql', query: { sql: text.slice(0,500), instanceId: id.value } }) }

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

function genAwr() {
  const sorted = [...awrSel.value].sort((a,b) => a.SNAP_ID - b.SNAP_ID)
  ElMessage.info(`已选快照 ${sorted[0].SNAP_ID} → ${sorted[sorted.length-1].SNAP_ID}，AWR生成功能需DBA权限在数据库端执行`)
}

function onTabChange(tab) {
  const name = tab.paneName
  if (name === 'perf' && !perf.value.metrics) loadPerf()
  else if (name === 'tablespaces' && !tablespaces.value.length) loadTablespaces()
  else if (name === 'sql' && !topSql.value.length) loadTopSql()
  else if (name === 'sessions' && !sessions.value.length) loadSessions()
  else if (name === 'alerts' && !instAlerts.value.length) loadAlerts()
  else if (name === 'trend') loadTrend()
  else if (name === 'waits') loadWaits()
  else if (name === 'locks') loadLocks()
  else if (name === 'awr' && !awrSnaps.value.length) loadAwr()
  else if (name === 'audit' && !auditLogs.value.length) loadAudit()
}

function refreshCurrent() {
  const loaders = { basic: loadBasic, perf: loadPerf, tablespaces: loadTablespaces,
    sql: loadTopSql, sessions: loadSessions, alerts: loadAlerts, trend: loadTrend, waits: loadWaits, locks: loadLocks, awr: loadAwr, audit: loadAudit }
  loaders[activeTab.value]?.()
}

onMounted(async () => {
  await loadBasic()
  try {
    const collectRes = await monitorApi.collectNow(id.value)
    await loadBasic()
    // 使用采集返回的维度数据更新健康详情
    if (collectRes.data?.dimensions) {
      healthDetail.value = {
        score: collectRes.data.healthScore,
        dimensions: collectRes.data.dimensions,
        collectedAt: new Date().toISOString(),
      }
      await nextTick()
      initHealthRadar()
    } else {
      await loadHealthDetail()
    }
  } catch {
    await loadHealthDetail()
  }
})
</script>

<style scoped>
.detail-header { display: flex; justify-content: space-between; align-items: center; }
.dh-title { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.inst-name { font-size: 20px; font-weight: 700; color: var(--agent-text, #303133); }
.status-chip { font-size: 14px; }
.dh-meta { display: flex; align-items: center; gap: 16px; color: var(--agent-text-muted, #909399); font-size: 13px; }
.dh-meta .el-icon { margin-right: 2px; }
.dh-right { display: flex; align-items: center; gap: 20px; }
.dh-actions { display: flex; flex-direction: column; gap: 8px; }

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
</style>
