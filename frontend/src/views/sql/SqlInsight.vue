<template>
  <div class="sql-insight">
    <!-- 顶部：实例 + 采集 -->
    <div class="card toolbar">
      <div class="toolbar-left">
        <el-select v-if="!embedded" v-model="instId" placeholder="全部实例" clearable filterable size="small" style="width: 220px" @change="reloadAll">
          <el-option v-for="i in instances" :key="i.INSTANCE_ID" :label="`${i.INSTANCE_NAME}（${i.DB_TYPE}）`" :value="i.INSTANCE_ID" />
        </el-select>
        <template v-if="instId">
          <el-tooltip content="规则阈值按业务类型覆盖（如批处理慢 SQL 阈值 60 秒）" placement="bottom">
            <el-select v-model="bizType" size="small" style="width: 120px" :disabled="!canAdmin" @change="saveBizType">
              <el-option label="OLTP" value="OLTP" /><el-option label="批处理" value="BATCH" /><el-option label="报表" value="REPORT" />
            </el-select>
          </el-tooltip>
          <el-button size="small" icon="Refresh" :loading="collecting" :disabled="!canOps" @click="collectNow">立即采集</el-button>
          <el-button size="small" link type="primary" @click="openCapability">能力矩阵</el-button>
        </template>
      </div>
      <div class="toolbar-right text-gray">
        <el-button v-if="!embedded" size="small" type="primary" plain icon="Monitor" style="margin-right: 8px" @click="$router.push('/sql-insight/screen')">监控大屏</el-button>
        <span v-if="overview.collect">近 10 分钟：{{ overview.collect.INSTANCES || 0 }} 个实例 · {{ overview.collect.ASSETS || 0 }} 条 SQL · 最近窗口 {{ fmt(overview.collect.LAST_WINDOW) }}</span>
        <el-tag v-if="overview.lastError" type="danger" size="small" style="margin-left: 8px">采集异常：{{ overview.lastError }}</el-tag>
      </div>
    </div>

    <el-alert v-if="serviceError" type="error" show-icon :closable="false" title="SQL 洞察服务不可用" class="svc-alert">
      <div>{{ serviceError }}</div>
      <div style="margin-top: 6px"><el-button size="small" @click="reloadAll">重试</el-button></div>
    </el-alert>

    <el-tabs v-model="tab" class="insight-tabs" @tab-change="onTab">
      <!-- 概览 -->
      <el-tab-pane label="概览" name="overview">
        <div class="stat-row">
          <div class="card stat"><div class="stat-num danger">{{ sumBy(overview.problems, 'CRITICAL') }}</div><div class="text-gray">严重问题</div></div>
          <div class="card stat"><div class="stat-num warning">{{ sumBy(overview.problems, 'WARNING') }}</div><div class="text-gray">警告问题</div></div>
          <div class="card stat"><div class="stat-num danger">{{ sumType(overview.anomalies, 'SUSTAINED') }}</div><div class="text-gray">持续升高</div></div>
          <div class="card stat"><div class="stat-num">{{ sumType(overview.anomalies, 'SPIKE') }}</div><div class="text-gray">突增（仅记录）</div></div>
          <div class="card stat"><div class="stat-num warning">{{ sumType(overview.anomalies, 'SLOW_DEGRADATION') }}</div><div class="text-gray">缓慢劣化</div></div>
        </div>
        <div class="grid-2">
          <div class="card">
            <div class="card-title db-time-head">
              <span>DB Time Top 10（近 {{ dbTimeHours }} 小时）</span>
              <el-select v-model="dbTimeHours" size="small" style="width: 120px" @change="loadOverview">
                <el-option v-for="h in 24" :key="h" :label="`${h} 小时`" :value="h" />
              </el-select>
            </div>
            <el-table :data="overview.dbTimeTop || []" size="small" stripe>
              <el-table-column prop="ASSET_ID" label="SQL#" width="80">
                <template #default="{ row }"><el-button link type="primary" @click="openAsset(row.ASSET_ID, row.INSTANCE_ID)">{{ row.ASSET_ID }}</el-button></template>
              </el-table-column>
              <el-table-column prop="SQL_TEXT" label="SQL" min-width="220" show-overflow-tooltip />
              <el-table-column prop="TOTAL_MS" label="总耗时(ms)" width="100" />
              <el-table-column prop="AVG_MS" label="均耗时" width="80" />
              <el-table-column prop="EXECS" label="执行" width="80" />
            </el-table>
          </div>
          <div class="card">
            <div class="card-title">问题分布 / 未执行的规则</div>
            <el-table :data="overview.problemsByRule || []" size="small" stripe max-height="200">
              <el-table-column prop="RULE_CODE" label="规则" width="90" />
              <el-table-column label="名称"><template #default="{ row }">{{ ruleName(row.RULE_CODE) }}</template></el-table-column>
              <el-table-column prop="CNT" label="未关闭" width="80" />
            </el-table>
            <div v-if="(overview.skipped || []).length" class="skipped">
              <div class="text-gray" style="margin: 8px 0 4px">以下规则因源库不提供对应指标而未执行（不代表“没问题”）：</div>
              <el-tag v-for="s in overview.skipped" :key="s.RULE_CODE + s.INSTANCE_ID" size="small" type="info" style="margin: 2px">
                {{ s.RULE_CODE }} · {{ s.DETAIL }}
              </el-tag>
            </div>
          </div>
        </div>
      </el-tab-pane>

      <!-- 问题 SQL -->
      <el-tab-pane label="问题SQL" name="problems">
        <div class="card">
          <div class="filters">
            <el-select v-model="pq.status" size="small" style="width: 110px" @change="loadProblems(1)">
              <el-option label="未关闭" value="OPEN" /><el-option label="未执行" value="SKIPPED" /><el-option label="已恢复" value="RESOLVED" /><el-option label="全部" value="ALL" />
            </el-select>
            <el-select v-model="pq.severity" size="small" clearable placeholder="级别" style="width: 100px" @change="loadProblems(1)">
              <el-option label="严重" value="CRITICAL" /><el-option label="警告" value="WARNING" />
            </el-select>
            <el-select v-model="pq.ruleCode" size="small" clearable filterable placeholder="规则" style="width: 180px" @change="loadProblems(1)">
              <el-option v-for="r in runtimeRules" :key="r.RULE_CODE" :label="`${r.RULE_CODE} ${r.RULE_NAME}`" :value="r.RULE_CODE" />
            </el-select>
          </div>
          <el-table :data="problems.list" size="small" stripe v-loading="loading.problems">
            <el-table-column label="级别" width="80"><template #default="{ row }"><el-tag :type="sevType(row.SEVERITY)" size="small">{{ row.SEVERITY }}</el-tag></template></el-table-column>
            <el-table-column label="规则" width="160"><template #default="{ row }">{{ row.RULE_CODE }} {{ row.RULE_NAME }}</template></el-table-column>
            <el-table-column v-if="!instId" prop="INSTANCE_NAME" label="实例" width="110" show-overflow-tooltip />
            <el-table-column prop="DETAIL" label="说明" min-width="220" show-overflow-tooltip />
            <el-table-column prop="SQL_TEXT" label="SQL" min-width="200" show-overflow-tooltip>
              <template #default="{ row }"><el-button v-if="row.ASSET_ID" link type="primary" @click="openAsset(row.ASSET_ID, row.INSTANCE_ID)">{{ (row.SQL_TEXT || '').slice(0, 60) }}</el-button></template>
            </el-table-column>
            <el-table-column prop="HIT_COUNT" label="命中" width="60" />
            <el-table-column label="最近" width="140"><template #default="{ row }">{{ fmt(row.LAST_SEEN) }}</template></el-table-column>
            <el-table-column label="操作" width="200" fixed="right">
              <template #default="{ row }">
                <el-button v-if="row.SQL_TEXT" link type="primary" size="small" @click="toAiOpt(row.SQL_TEXT, row.INSTANCE_ID)">规则优化</el-button>
                <el-button v-if="row.TICKET_ID" link type="success" size="small" @click="$router.push({ path: '/sql-review', query: { ticketId: row.TICKET_ID } })">工单#{{ row.TICKET_ID }}</el-button>
                <el-button v-else-if="row.ASSET_ID && canOps" link type="warning" size="small"
                  @click.stop="openTicketDialog({ problemId: row.PROBLEM_ID, sqlText: row.SQL_TEXT })">生成工单</el-button>
                <el-button v-if="row.STATUS === 'OPEN' && canOps" link size="small" @click="resolveProblem(row)">关闭</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-pagination class="pager" small layout="total, prev, pager, next" :total="problems.total" :page-size="20" v-model:current-page="pq.page" @current-change="loadProblems" />
        </div>
      </el-tab-pane>

      <!-- 异常波动 -->
      <el-tab-pane label="异常波动" name="anomalies">
        <div class="card">
          <div class="filters">
            <el-select v-model="aq.status" size="small" style="width: 110px" @change="loadAnomalies(1)">
              <el-option label="未恢复" value="OPEN" /><el-option label="已恢复" value="RESOLVED" /><el-option label="已接受" value="ACCEPTED" /><el-option label="全部" value="ALL" />
            </el-select>
            <el-select v-model="aq.type" size="small" clearable placeholder="类型" style="width: 120px" @change="loadAnomalies(1)">
              <el-option label="持续升高" value="SUSTAINED" /><el-option label="突增" value="SPIKE" /><el-option label="缓慢劣化" value="SLOW_DEGRADATION" />
            </el-select>
          </div>
          <el-table :data="anomalies.list" size="small" stripe v-loading="loading.anomalies" @row-click="(r) => openAnomaly(r.ANOMALY_ID)">
            <el-table-column label="级别" width="80"><template #default="{ row }"><el-tag :type="sevType(row.SEVERITY)" size="small">{{ row.SEVERITY }}</el-tag></template></el-table-column>
            <el-table-column label="类型" width="90"><template #default="{ row }">{{ typeLabel(row.ANOMALY_TYPE) }}</template></el-table-column>
            <el-table-column v-if="!instId" prop="INSTANCE_NAME" label="实例" width="110" show-overflow-tooltip />
            <el-table-column label="对象" width="110"><template #default="{ row }">{{ row.SCOPE === 'INSTANCE' ? '实例级' : 'SQL#' + row.ASSET_ID }}</template></el-table-column>
            <el-table-column label="指标" width="120"><template #default="{ row }">{{ metricLabel(row.METRIC) }}{{ row.DIRECTION === 'DOWN' ? '↓' : row.METRIC ? '↑' : '' }}</template></el-table-column>
            <el-table-column label="基线 → 当前" width="150"><template #default="{ row }">{{ num(row.BASELINE_VALUE) }} → {{ num(row.CURRENT_VALUE) }}</template></el-table-column>
            <el-table-column label="倍率" width="70"><template #default="{ row }">{{ row.RATIO ? Number(row.RATIO).toFixed(1) + 'x' : '-' }}</template></el-table-column>
            <el-table-column label="可能原因" width="120"><template #default="{ row }">{{ causeLabel(row.PRIMARY_CAUSE) }}</template></el-table-column>
            <el-table-column label="变更窗口" width="80"><template #default="{ row }"><el-tag v-if="row.IN_CHANGE_WINDOW == 1" size="small" type="info">是</el-tag></template></el-table-column>
            <el-table-column label="开始" width="140"><template #default="{ row }">{{ fmt(row.START_TIME) }}</template></el-table-column>
            <el-table-column prop="STATUS" label="状态" width="90" />
          </el-table>
          <el-pagination class="pager" small layout="total, prev, pager, next" :total="anomalies.total" :page-size="20" v-model:current-page="aq.page" @current-change="loadAnomalies" />
        </div>
      </el-tab-pane>

      <!-- SQL 资产 -->
      <el-tab-pane label="SQL资产" name="assets">
        <div class="card">
          <div class="filters">
            <el-input v-model="sq.keyword" size="small" clearable placeholder="SQL 关键字 / 表名 / 指纹" style="width: 260px" @keyup.enter="loadAssets(1)" @clear="loadAssets(1)" />
            <el-checkbox v-model="sq.core" size="small" @change="loadAssets(1)">只看核心 SQL</el-checkbox>
          </div>
          <el-table :data="assets.list" size="small" stripe v-loading="loading.assets">
            <el-table-column prop="ASSET_ID" label="SQL#" width="80">
              <template #default="{ row }"><el-button link type="primary" @click="openAsset(row.ASSET_ID, instId)">{{ row.ASSET_ID }}</el-button></template>
            </el-table-column>
            <el-table-column prop="DB_TYPE" label="方言" width="90" />
            <el-table-column prop="SCHEMA_NAME" label="Schema" width="100" show-overflow-tooltip />
            <el-table-column prop="STMT_TYPE" label="类型" width="80" />
            <el-table-column prop="SQL_TEXT" label="SQL" min-width="260" show-overflow-tooltip />
            <el-table-column label="静态风险" width="90"><template #default="{ row }"><el-tag v-if="row.STATIC_RISK && row.STATIC_RISK !== 'NONE'" :type="sevType(row.STATIC_RISK)" size="small">{{ row.STATIC_RISK }}</el-tag><span v-else-if="row.STATIC_STATUS === 'UNANALYZED'" class="text-gray">未分析</span></template></el-table-column>
            <el-table-column label="问题/波动" width="90"><template #default="{ row }">{{ row.OPEN_PROBLEMS }} / {{ row.OPEN_ANOMALIES }}</template></el-table-column>
            <el-table-column label="核心" width="60"><template #default="{ row }"><el-icon v-if="row.IS_CORE == 1" color="#e6a23c"><StarFilled /></el-icon></template></el-table-column>
            <el-table-column label="最近出现" width="140"><template #default="{ row }">{{ fmt(row.LAST_SEEN) }}</template></el-table-column>
          </el-table>
          <el-pagination class="pager" small layout="total, prev, pager, next" :total="assets.total" :page-size="20" v-model:current-page="sq.page" @current-change="loadAssets" />
        </div>
      </el-tab-pane>

      <!-- 规则配置 -->
      <el-tab-pane v-if="!embedded" label="规则阈值" name="rules">
        <div class="card">
          <p class="text-gray">覆盖优先级：SQL &gt; 实例 &gt; 业务类型 &gt; 数据库类型 &gt; 全局。审核（S-/D-/H-）与运行态（P-）规则在所有入口共用同一套配置。</p>
          <el-table :data="rules" size="small" stripe v-loading="loading.rules" max-height="560">
            <el-table-column prop="RULE_CODE" label="编码" width="80" />
            <el-table-column prop="RULE_NAME" label="名称" width="180" show-overflow-tooltip />
            <el-table-column prop="CATEGORY" label="类别" width="90" />
            <el-table-column label="作用域" width="150"><template #default="{ row }">{{ row.SCOPE_TYPE }}{{ row.SCOPE_VALUE !== '*' ? ' = ' + row.SCOPE_VALUE : '' }}</template></el-table-column>
            <el-table-column label="启用" width="70"><template #default="{ row }"><el-tag :type="row.ENABLED == 1 ? 'success' : 'info'" size="small">{{ row.ENABLED == 1 ? '是' : '否' }}</el-tag></template></el-table-column>
            <el-table-column prop="SEVERITY" label="级别" width="90" />
            <el-table-column prop="PARAMS" label="参数" min-width="200" show-overflow-tooltip />
            <el-table-column prop="DESCRIPTION" label="说明" min-width="200" show-overflow-tooltip />
            <el-table-column label="操作" width="130" fixed="right">
              <template #default="{ row }">
                <el-button v-if="canAdmin" link type="primary" size="small" @click="editRule(row)">编辑/覆盖</el-button>
                <el-button v-if="canAdmin && row.SCOPE_TYPE !== 'GLOBAL'" link type="danger" size="small" @click="deleteRule(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>

      <!-- 变更窗口 -->
      <el-tab-pane label="计划变化" name="plans">
        <div class="card">
          <div class="filters">
            <el-select v-model="planHours" size="small" style="width: 120px" @change="loadPlans">
              <el-option label="近 6 小时" :value="6" /><el-option label="近 24 小时" :value="24" /><el-option label="近 3 天" :value="72" /><el-option label="近 7 天" :value="168" />
            </el-select>
            <span class="text-gray">窗口内出现、此前 7 天没出现过的执行计划，与旧计划对比单次耗时（≥1.5 倍判为退化）。{{ plans.note }}</span>
          </div>
          <el-alert v-if="(plans.unsupported || []).length" type="info" :closable="false" show-icon style="margin-bottom: 8px"
                    :title="`不参与检测的实例：${plans.unsupported.map(x => x.INSTANCE_NAME + '(' + x.DB_TYPE + ')').join('、')}`" />
          <el-table :data="plans.list || []" size="small" stripe v-loading="loading.plans">
            <el-table-column label="判定" width="80">
              <template #default="{ row }"><el-tag size="small" :type="{ REGRESSION: 'danger', IMPROVED: 'success', SIMILAR: 'info' }[row.VERDICT] || 'info'">{{ { REGRESSION: '退化', IMPROVED: '改善', SIMILAR: '相近', UNKNOWN: '未知' }[row.VERDICT] }}</el-tag></template>
            </el-table-column>
            <el-table-column v-if="!instId" prop="INSTANCE_NAME" label="实例" width="110" show-overflow-tooltip />
            <el-table-column label="SQL" min-width="220" show-overflow-tooltip>
              <template #default="{ row }"><el-button link type="primary" @click="openAsset(row.ASSET_ID, row.INSTANCE_ID)">#{{ row.ASSET_ID }} {{ (row.SQL_TEXT || '').slice(0, 60) }}</el-button></template>
            </el-table-column>
            <el-table-column label="旧计划 → 新计划" width="200"><template #default="{ row }">{{ row.OLD_PLAN_HASH || '-' }} → {{ row.PLAN_HASH }}</template></el-table-column>
            <el-table-column label="旧 / 新 均耗时(ms)" width="150"><template #default="{ row }">{{ num(row.OLD_AVG_MS) }} / {{ num(row.NEW_AVG_MS) }}</template></el-table-column>
            <el-table-column label="倍率" width="70"><template #default="{ row }"><span :class="{ danger: row.RATIO >= 1.5 }">{{ row.RATIO ? row.RATIO + 'x' : '-' }}</span></template></el-table-column>
            <el-table-column prop="EXECS" label="新计划执行" width="90" />
            <el-table-column label="首次出现" width="140"><template #default="{ row }">{{ fmt(row.FIRST_SEEN) }}</template></el-table-column>
            <el-table-column label="操作" width="90" fixed="right">
              <template #default="{ row }"><el-button link type="primary" size="small" @click="toAiOpt(row.SQL_TEXT, row.INSTANCE_ID)">规则优化</el-button></template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>

      <el-tab-pane label="变更窗口" name="windows">
        <div class="card">
          <div class="filters">
            <el-button v-if="canOps" size="small" type="primary" @click="cwDialog = true">登记变更窗口</el-button>
            <span class="text-gray">窗口内数据照常采集，但不进入基线、不推送波动告警；发布工单执行时会自动登记。</span>
          </div>
          <el-table :data="windows.list" size="small" stripe v-loading="loading.windows">
            <el-table-column prop="WINDOW_TYPE" label="类型" width="110" />
            <el-table-column prop="TITLE" label="标题" min-width="200" show-overflow-tooltip />
            <el-table-column label="实例" width="130"><template #default="{ row }">{{ row.INSTANCE_NAME || '全部实例' }}</template></el-table-column>
            <el-table-column label="开始" width="150"><template #default="{ row }">{{ fmt(row.START_TIME) }}</template></el-table-column>
            <el-table-column label="结束" width="150"><template #default="{ row }">{{ fmt(row.END_TIME) }}</template></el-table-column>
            <el-table-column prop="SOURCE" label="来源" width="90" />
            <el-table-column prop="CREATED_BY" label="登记人" width="100" />
            <el-table-column label="操作" width="80"><template #default="{ row }"><el-button v-if="canAdmin" link type="danger" size="small" @click="deleteWindow(row)">删除</el-button></template></el-table-column>
          </el-table>
          <el-pagination class="pager" small layout="total, prev, pager, next" :total="windows.total" :page-size="20" v-model:current-page="wq.page" @current-change="loadWindows" />
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- SQL 资产详情 -->
    <el-drawer v-model="assetVisible" :title="`SQL#${asset?.ASSET_ID || ''}`" size="62%" destroy-on-close>
      <template v-if="asset">
        <div class="asset-head">
          <el-tag size="small">{{ asset.DB_TYPE }}</el-tag>
          <el-tag size="small" type="info">{{ asset.SCHEMA_NAME }}</el-tag>
          <el-tag size="small" type="info">{{ asset.STMT_TYPE }}</el-tag>
          <span class="text-gray">指纹 {{ asset.FINGERPRINT }}</span>
          <span style="flex: 1" />
          <el-switch v-model="assetCore" :disabled="!canOps" active-text="核心 SQL" size="small" @change="saveCore" />
          <el-button size="small" type="primary" @click="toAiOpt(asset.SAMPLE_SQL, assetInst)">AI 优化</el-button>
        </div>
        <pre class="sql-box">{{ asset.SAMPLE_SQL }}</pre>
        <div v-if="assetInst" class="card">
          <div class="card-title" style="justify-content: space-between">
            <span>运行趋势（实例 {{ instName(assetInst) }}）</span>
            <span>
              <el-select v-model="trendMetric" size="small" style="width: 150px" @change="loadTrend">
                <el-option v-for="m in METRICS" :key="m.key" :label="m.label" :value="m.key" />
              </el-select>
              <el-select v-model="trendHours" size="small" style="width: 100px; margin-left: 6px" @change="loadTrend">
                <el-option label="6 小时" :value="6" /><el-option label="24 小时" :value="24" /><el-option label="7 天" :value="168" /><el-option label="28 天" :value="672" />
              </el-select>
            </span>
          </div>
          <div ref="trendEl" class="trend" />
          <div class="text-gray" style="font-size: 12px">虚线为当前时段基线中位数；红点为“四项判定”命中的窗口。</div>
        </div>
        <div v-else class="text-gray">该 SQL 出现在 {{ (asset.sources || []).length }} 个实例上，选择实例后可查看趋势：
          <el-button v-for="s in uniqSources(asset.sources)" :key="s.INSTANCE_ID" link type="primary" @click="assetInst = s.INSTANCE_ID; loadTrend()">{{ s.INSTANCE_NAME || s.INSTANCE_ID }}</el-button>
        </div>
        <el-tabs>
          <el-tab-pane :label="`静态分析（${staticFindings.length}）`">
            <el-table :data="staticFindings" size="small">
              <el-table-column prop="code" label="规则" width="80" />
              <el-table-column label="级别" width="90"><template #default="{ row }"><el-tag :type="sevType(row.severity)" size="small">{{ row.severity }}</el-tag></template></el-table-column>
              <el-table-column prop="message" label="说明" min-width="240" />
              <el-table-column prop="suggestion" label="建议" min-width="200" />
            </el-table>
          </el-tab-pane>
          <el-tab-pane :label="`运行时问题（${(asset.problems || []).length}）`">
            <el-table :data="asset.problems" size="small">
              <el-table-column prop="RULE_CODE" label="规则" width="80" />
              <el-table-column prop="STATUS" label="状态" width="90" />
              <el-table-column prop="DETAIL" label="说明" min-width="260" />
              <el-table-column label="最近" width="140"><template #default="{ row }">{{ fmt(row.LAST_SEEN) }}</template></el-table-column>
            </el-table>
          </el-tab-pane>
          <el-tab-pane :label="`波动史（${(asset.anomalies || []).length}）`">
            <el-table :data="asset.anomalies" size="small" @row-click="(r) => openAnomaly(r.ANOMALY_ID)">
              <el-table-column label="类型" width="90"><template #default="{ row }">{{ typeLabel(row.ANOMALY_TYPE) }}</template></el-table-column>
              <el-table-column label="指标" width="120"><template #default="{ row }">{{ metricLabel(row.METRIC) }}</template></el-table-column>
              <el-table-column prop="STATUS" label="状态" width="90" />
              <el-table-column prop="DETAIL" label="说明" min-width="260" show-overflow-tooltip />
              <el-table-column label="开始" width="140"><template #default="{ row }">{{ fmt(row.START_TIME) }}</template></el-table-column>
            </el-table>
          </el-tab-pane>
          <el-tab-pane :label="`审核记录（${(asset.audits || []).length}）`">
            <el-table :data="asset.audits" size="small">
              <el-table-column prop="AUDIT_ID" label="审核ID" width="90" />
              <el-table-column prop="SCORE" label="评分" width="70" />
              <el-table-column prop="RISK_LEVEL" label="风险" width="90" />
              <el-table-column prop="SOURCE" label="来源" width="110" />
              <el-table-column label="时间"><template #default="{ row }">{{ fmt(row.CREATED_AT) }}</template></el-table-column>
            </el-table>
          </el-tab-pane>
          <el-tab-pane label="基线锚点">
            <el-table :data="asset.anchors" size="small">
              <el-table-column prop="REASON" label="原因" width="130" />
              <el-table-column label="时间" width="150"><template #default="{ row }">{{ fmt(row.ANCHOR_TIME) }}</template></el-table-column>
              <el-table-column prop="OPERATOR" label="操作人" width="100" />
              <el-table-column prop="NOTE" label="备注" />
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </template>
    </el-drawer>

    <!-- 波动详情 + 诊断 -->
    <el-drawer v-model="anomalyVisible" :title="anomaly ? `${typeLabel(anomaly.ANOMALY_TYPE)} · ${anomaly.SCOPE === 'INSTANCE' ? '实例级' : 'SQL#' + anomaly.ASSET_ID}` : ''" size="55%" destroy-on-close>
      <template v-if="anomaly">
        <el-descriptions :column="2" size="small" border>
          <el-descriptions-item label="实例">{{ anomaly.INSTANCE_NAME }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ anomaly.STATUS }}</el-descriptions-item>
          <el-descriptions-item label="指标">{{ metricLabel(anomaly.METRIC) }} {{ anomaly.DIRECTION }}</el-descriptions-item>
          <el-descriptions-item label="级别">{{ anomaly.SEVERITY }}</el-descriptions-item>
          <el-descriptions-item label="基线 / 当前 / 峰值">{{ num(anomaly.BASELINE_VALUE) }} / {{ num(anomaly.CURRENT_VALUE) }} / {{ num(anomaly.PEAK_VALUE) }}</el-descriptions-item>
          <el-descriptions-item label="倍率 / Z">{{ num(anomaly.RATIO) }} / {{ num(anomaly.Z_SCORE) }}</el-descriptions-item>
          <el-descriptions-item label="开始">{{ fmt(anomaly.START_TIME) }}</el-descriptions-item>
          <el-descriptions-item label="最近">{{ fmt(anomaly.LAST_TIME) }}</el-descriptions-item>
          <el-descriptions-item label="说明" :span="2">{{ anomaly.DETAIL }}</el-descriptions-item>
        </el-descriptions>
        <div class="actions">
          <el-button size="small" :loading="diagnosing" :disabled="!canOps" @click="runDiagnose">重新诊断</el-button>
          <el-button v-if="anomaly.ASSET_ID" size="small" @click="openAsset(anomaly.ASSET_ID, anomaly.INSTANCE_ID)">查看 SQL</el-button>
          <el-button v-if="anomaly.SAMPLE_SQL" size="small" type="primary" @click="toAiOpt(anomaly.SAMPLE_SQL, anomaly.INSTANCE_ID)">规则优化</el-button>
          <el-button v-if="(anomaly.diagnosis || []).length" size="small" @click="toAiExplain(anomaly)">交给 AI 解读</el-button>
          <el-button v-if="anomaly.TICKET_ID" size="small" type="success" plain @click="$router.push({ path: '/sql-review', query: { ticketId: anomaly.TICKET_ID } })">优化工单 #{{ anomaly.TICKET_ID }}</el-button>
          <el-button v-else-if="anomaly.ASSET_ID && canOps" size="small" type="warning" plain
            @click="openTicketDialog({ anomalyId: anomaly.ANOMALY_ID, sqlText: anomaly.SQL_TEXT || anomaly.SAMPLE_SQL })">生成优化工单</el-button>
          <el-button v-if="anomaly.STATUS === 'OPEN' && anomaly.ASSET_ID && canAdmin" size="small" type="warning" @click="acceptBaseline">接受为新基线</el-button>
          <el-button v-if="anomaly.STATUS === 'OPEN' && canOps" size="small" @click="resolveAnomaly">关闭</el-button>
        </div>
        <div v-for="d in (anomaly.diagnosis || []).slice(0, 1)" :key="d.DIAG_ID" class="card">
          <div class="card-title">诊断（{{ fmt(d.CREATED_AT) }}）<el-tag v-if="d.STATUS === 'FAILED'" type="danger" size="small">失败：{{ d.ERROR_MSG }}</el-tag></div>
          <div v-for="c in (d.EVIDENCE?.causes || [])" :key="c.code" class="cause">
            <div><el-tag size="small" :type="c.code === 'UNKNOWN' ? 'info' : 'danger'">{{ c.code }}</el-tag> <b>{{ c.title }}</b></div>
            <div class="text-gray">证据：</div>
            <ul><li v-for="e in c.evidence" :key="e">{{ e }}</li></ul>
            <div class="text-gray">建议：</div>
            <ul><li v-for="s in c.suggestions" :key="s">{{ s }}</li></ul>
          </div>
          <div v-if="(d.EVIDENCE?.changes || []).length" class="text-gray" style="font-size: 12px">同时段变更（作为证据，不单独作为原因）：{{ d.EVIDENCE.changes.join('；') }}</div>
          <el-collapse v-if="d.REPORT_TEXT" style="margin-top: 6px">
            <el-collapse-item title="诊断报告（文本）"><pre class="sql-box">{{ d.REPORT_TEXT }}</pre></el-collapse-item>
          </el-collapse>
          <el-table v-if="d.SNAPSHOT?.metrics" :data="d.SNAPSHOT.metrics" size="small" style="margin-top: 8px">
            <el-table-column prop="label" label="指标" width="140" />
            <el-table-column label="最近15分钟"><template #default="{ row }">{{ num(row.current) }}</template></el-table-column>
            <el-table-column label="基线"><template #default="{ row }">{{ num(row.baseline) }} <span class="text-gray">{{ row.slot }}</span></template></el-table-column>
            <el-table-column label="倍率"><template #default="{ row }"><span :class="{ danger: row.ratio >= 2 }">{{ row.ratio ? row.ratio + 'x' : '-' }}</span></template></el-table-column>
          </el-table>
          <el-table v-if="d.SNAPSHOT?.plans?.length" :data="d.SNAPSHOT.plans" size="small" style="margin-top: 8px">
            <el-table-column prop="PLAN_HASH" label="执行计划" />
            <el-table-column prop="EXECS" label="执行次数" width="100" />
            <el-table-column prop="AVG_MS" label="均耗时(ms)" width="100" />
            <el-table-column label="首次" width="140"><template #default="{ row }">{{ fmt(row.FIRST_SEEN) }}</template></el-table-column>
            <el-table-column label="最近" width="140"><template #default="{ row }">{{ fmt(row.LAST_SEEN) }}</template></el-table-column>
          </el-table>
        </div>
        <el-empty v-if="!(anomaly.diagnosis || []).length" description="暂无诊断（持续升高 / 缓慢劣化时自动诊断，也可手动诊断）" :image-size="60" />
      </template>
    </el-drawer>

    <!-- 规则编辑 -->
    <el-dialog v-model="ruleDialog" title="规则配置" width="520px">
      <el-form :model="ruleForm" label-width="90px" size="small">
        <el-form-item label="规则">{{ ruleForm.ruleCode }} {{ ruleForm.ruleName }}</el-form-item>
        <el-form-item label="作用域">
          <el-select v-model="ruleForm.scopeType" style="width: 140px">
            <el-option v-for="s in ['GLOBAL', 'DB_TYPE', 'BIZ_TYPE', 'INSTANCE', 'SQL']" :key="s" :label="s" :value="s" />
          </el-select>
          <el-input v-if="ruleForm.scopeType !== 'GLOBAL'" v-model="ruleForm.scopeValue" style="width: 200px; margin-left: 6px"
                    :placeholder="{ DB_TYPE: 'ORACLE / MYSQL / PANWEI…', BIZ_TYPE: 'OLTP / BATCH / REPORT', INSTANCE: '实例ID', SQL: 'SQL#（资产ID）' }[ruleForm.scopeType]" />
        </el-form-item>
        <el-form-item label="启用"><el-switch v-model="ruleForm.enabled" /></el-form-item>
        <el-form-item label="级别">
          <el-select v-model="ruleForm.severity" clearable placeholder="继承" style="width: 140px">
            <el-option label="CRITICAL" value="CRITICAL" /><el-option label="WARNING" value="WARNING" /><el-option label="INFO" value="INFO" />
          </el-select>
        </el-form-item>
        <el-form-item label="参数(JSON)"><el-input v-model="ruleForm.params" type="textarea" :rows="3" placeholder='如 {"avgElapsedMs":60000}，只写需要覆盖的键' /></el-form-item>
      </el-form>
      <template #footer>
        <el-button size="small" @click="ruleDialog = false">取消</el-button>
        <el-button size="small" type="primary" :loading="saving" @click="saveRule">保存</el-button>
      </template>
    </el-dialog>

    <!-- 变更窗口 -->
    <el-dialog v-model="cwDialog" title="登记变更窗口" width="480px">
      <el-form :model="cwForm" label-width="80px" size="small">
        <el-form-item label="类型"><el-select v-model="cwForm.windowType"><el-option label="发布" value="RELEASE" /><el-option label="批处理" value="BATCH" /><el-option label="维护" value="MAINTENANCE" /></el-select></el-form-item>
        <el-form-item label="标题"><el-input v-model="cwForm.title" /></el-form-item>
        <el-form-item label="实例"><el-select v-model="cwForm.instanceId" clearable placeholder="全部实例" filterable><el-option v-for="i in instances" :key="i.INSTANCE_ID" :label="i.INSTANCE_NAME" :value="i.INSTANCE_ID" /></el-select></el-form-item>
        <el-form-item label="时间"><el-date-picker v-model="cwForm.range" type="datetimerange" value-format="x" start-placeholder="开始" end-placeholder="结束" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button size="small" @click="cwDialog = false">取消</el-button>
        <el-button size="small" type="primary" :loading="saving" @click="saveWindow">保存</el-button>
      </template>
    </el-dialog>

    <!-- 生成 SQL 评审工单 -->
    <el-dialog v-model="ticketDialog" title="生成 SQL 评审工单" width="520px" :close-on-click-modal="false" destroy-on-close>
      <el-alert type="info" show-icon :closable="false" style="margin-bottom: 12px"
        title="可不指定审核人，工单将进入 DBA 待审池；指定后仅该审核人（及管理员）可人工通过/拒绝。" />
      <el-form label-width="100px" size="default">
        <el-form-item label="指定审核人">
          <el-select v-model="ticketForm.assignedTo" placeholder="未指派（DBA 待审池）" clearable filterable style="width: 100%">
            <el-option v-for="u in reviewers" :key="u.USER_ID" :label="(u.REAL_NAME || u.USERNAME) + ' (' + u.ROLE + ')'" :value="u.USER_ID" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="ticketForm.note" type="textarea" :rows="2" placeholder="可选" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="ticketDialog = false">取消</el-button>
        <el-button type="primary" :loading="ticketSubmitting" @click="submitInsightTicket">生成工单</el-button>
      </template>
    </el-dialog>

    <!-- 能力矩阵 -->
    <el-dialog v-model="capDialog" title="采集能力矩阵" width="560px">
      <p class="text-gray">不支持的指标不参与规则与波动检测（界面显示“不支持”，不会按 0 处理）。</p>
      <el-table :data="capability.items || []" size="small">
        <el-table-column prop="METRIC" label="指标" width="140" />
        <el-table-column label="支持" width="80"><template #default="{ row }"><el-tag :type="row.SUPPORTED == 1 ? 'success' : 'info'" size="small">{{ row.SUPPORTED == 1 ? '支持' : '不支持' }}</el-tag></template></el-table-column>
        <el-table-column prop="SOURCE" label="来源" show-overflow-tooltip />
        <el-table-column prop="DETAIL" label="说明" show-overflow-tooltip />
      </el-table>
      <template #footer><el-button size="small" :disabled="!canOps" @click="reprobe">重新探测</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch, nextTick, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as echarts from 'echarts'
import { sqlInsightApi, sqlReviewApi, cmdbApi } from '@/api/index.js'
import { useAuthStore } from '@/stores/auth.js'

const props = defineProps({
  instanceId: { type: [Number, String], default: null },   // 嵌入实例详情时传入
  embedded: { type: Boolean, default: false },
})

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const role = computed(() => auth.user?.role || '')
const canAdmin = computed(() => ['ADMIN', 'DBA'].includes(role.value))
const canOps = computed(() => ['ADMIN', 'DBA', 'OPS'].includes(role.value))

const METRICS = [
  { key: 'avg_elapsed_ms', label: '平均耗时(ms)' }, { key: 'cpu_per_exec_ms', label: '单次CPU(ms)' },
  { key: 'logical_reads_per_exec', label: '单次逻辑读' }, { key: 'physical_reads_per_exec', label: '单次物理读' },
  { key: 'rows_examined_per_exec', label: '单次扫描行数' }, { key: 'scan_ratio', label: '扫描/返回比' },
  { key: 'exec_per_min', label: '每分钟执行次数' }, { key: 'db_time_share', label: 'DB Time 占比' }, { key: 'error_rate', label: '错误率' },
]
const CAUSES = { PLAN_REGRESSION: '执行计划退化', LOCK_WAIT: '锁等待', DATA_GROWTH_OR_SKEW: '数据增长/倾斜', CACHE_OR_IO: '缓存/IO', RESOURCE_CONTENTION: '资源争用', TRAFFIC_SURGE: '调用量突增', ERROR_SURGE: '错误率升高', UNKNOWN: '未明' }
const TYPES = { SUSTAINED: '持续升高', SPIKE: '突增', SLOW_DEGRADATION: '缓慢劣化' }

const instances = ref([])
const instId = ref(props.instanceId ? Number(props.instanceId) : (route.query.instanceId ? Number(route.query.instanceId) : null))
const bizType = ref('OLTP')
const tab = ref(props.embedded ? 'problems' : (route.query.tab || 'overview'))
const overview = ref({})
const rules = ref([])
const problems = reactive({ list: [], total: 0 })
const anomalies = reactive({ list: [], total: 0 })
const assets = reactive({ list: [], total: 0 })
const windows = reactive({ list: [], total: 0 })
const pq = reactive({ status: 'OPEN', severity: '', ruleCode: '', page: 1 })
const aq = reactive({ status: 'OPEN', type: '', page: 1 })
const sq = reactive({ keyword: '', core: false, page: 1 })
const wq = reactive({ page: 1 })
const loading = reactive({ problems: false, anomalies: false, assets: false, rules: false, windows: false, plans: false })
const collecting = ref(false)
const saving = ref(false)

const runtimeRules = computed(() => rules.value.filter((r) => r.SCOPE_TYPE === 'GLOBAL' && r.CATEGORY === 'RUNTIME'))
const ruleName = (code) => rules.value.find((r) => r.RULE_CODE === code && r.SCOPE_TYPE === 'GLOBAL')?.RULE_NAME || ''
const metricLabel = (k) => METRICS.find((m) => m.key === k)?.label || k || ''
const causeLabel = (c) => (c ? CAUSES[c] || c : '-')
const typeLabel = (t) => TYPES[t] || t
const sevType = (s) => ({ CRITICAL: 'danger', ERROR: 'danger', WARNING: 'warning', INFO: 'info' }[String(s || '').toUpperCase()] || 'info')
const sumBy = (rows, sev) => (rows || []).filter((r) => r.SEVERITY === sev).reduce((a, r) => a + Number(r.CNT || 0), 0)
const sumType = (rows, t) => (rows || []).filter((r) => r.ANOMALY_TYPE === t).reduce((a, r) => a + Number(r.CNT || 0), 0)
const instName = (id) => instances.value.find((i) => i.INSTANCE_ID == id)?.INSTANCE_NAME || id
const num = (v) => (v == null || v === '' ? '-' : Math.abs(Number(v)) >= 100 ? Number(v).toFixed(0) : Number(Number(v).toPrecision(3)))
function fmt(v) {
  if (!v) return '-'
  const d = new Date(v)
  return isNaN(d) ? String(v) : `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const params = (extra) => ({ instanceId: instId.value || undefined, ...extra })

// 服务不可用（Java 未启动 / 版本过旧 / 迁移脚本未执行）时在页面顶部给出一次明确提示，而不是每个标签各弹一个错误
const serviceError = ref('')
function onLoadError(e) {
  const msg = e?.message || '加载失败'
  if ([404, 500, 502, 503, 504].includes(Number(e?.code)) || /接口不存在|不可达|未初始化|Java/.test(msg)) serviceError.value = msg
  else ElMessage.error(msg)
}

async function loadInstances() {
  try {
    const r = await cmdbApi.list({ page: 1, size: 500 })
    instances.value = r.data?.list || r.data || []
  } catch { instances.value = [] }
}
async function loadOverview() {
  try { overview.value = (await sqlInsightApi.overview(params())).data || {}; serviceError.value = '' } catch (e) { overview.value = {}; onLoadError(e) }
  if (overview.value.bizType) bizType.value = overview.value.bizType
}
async function loadRules() {
  loading.rules = true
  try { rules.value = (await sqlInsightApi.rules()).data || [] } catch (e) { onLoadError(e) } finally { loading.rules = false }
}
async function loadProblems(p) {
  if (typeof p === 'number') pq.page = p
  loading.problems = true
  try { Object.assign(problems, (await sqlInsightApi.problems(params({ status: pq.status, severity: pq.severity || undefined, ruleCode: pq.ruleCode || undefined, page: pq.page, size: 20 }))).data) } catch (e) { onLoadError(e) } finally { loading.problems = false }
}
async function loadAnomalies(p) {
  if (typeof p === 'number') aq.page = p
  loading.anomalies = true
  try { Object.assign(anomalies, (await sqlInsightApi.anomalies(params({ status: aq.status, type: aq.type || undefined, page: aq.page, size: 20 }))).data) } catch (e) { onLoadError(e) } finally { loading.anomalies = false }
}
async function loadAssets(p) {
  if (typeof p === 'number') sq.page = p
  loading.assets = true
  try { Object.assign(assets, (await sqlInsightApi.assets(params({ keyword: sq.keyword || undefined, isCore: sq.core ? 1 : undefined, page: sq.page, size: 20 }))).data) } catch (e) { onLoadError(e) } finally { loading.assets = false }
}
async function loadWindows(p) {
  if (typeof p === 'number') wq.page = p
  loading.windows = true
  try { Object.assign(windows, (await sqlInsightApi.changeWindows(params({ page: wq.page, size: 20 }))).data) } catch (e) { onLoadError(e) } finally { loading.windows = false }
}
function onTab(name) {
  ({ overview: loadOverview, problems: () => loadProblems(1), anomalies: () => loadAnomalies(1), assets: () => loadAssets(1), rules: loadRules, windows: () => loadWindows(1), plans: loadPlans }[name] || (() => {}))()
}
function reloadAll() {
  bizType.value = 'OLTP'
  loadOverview()
  onTab(tab.value)
}

async function collectNow() {
  collecting.value = true
  try {
    const r = await sqlInsightApi.collect(instId.value)
    const d = r.data || {}
    if (d.error) ElMessage.warning(`采集失败：${d.error}`)
    else ElMessage.success(d.stored ? `本轮写入 ${d.stored} 条分钟统计（${d.costMs}ms）` : '已建立采集基准，下一分钟开始产生增量数据')
    reloadAll()
  } finally { collecting.value = false }
}
async function saveBizType() {
  await sqlInsightApi.setBizType(instId.value, { bizType: bizType.value })
  ElMessage.success('业务类型已保存，规则阈值按新类型生效')
}

// ---------- 能力矩阵
const capDialog = ref(false)
const capability = ref({})
async function openCapability() {
  capDialog.value = true
  try { capability.value = (await sqlInsightApi.capability(instId.value)).data || {} } catch (e) { ElMessage.error(e.message) }
}
async function reprobe() {
  await sqlInsightApi.collect(instId.value, true)
  capability.value = (await sqlInsightApi.capability(instId.value)).data || {}
  ElMessage.success('已重新探测')
}

// ---------- 资产详情
const assetVisible = ref(false)
const asset = ref(null)
const assetInst = ref(null)
const assetCore = ref(false)
const trendMetric = ref('avg_elapsed_ms')
const trendHours = ref(6)
const trendEl = ref()
let chart = null
const staticFindings = computed(() => asset.value?.STATIC_RESULT?.findings || [])
const uniqSources = (list) => Object.values(Object.fromEntries((list || []).map((s) => [s.INSTANCE_ID, s])))

async function openAsset(id, inst) {
  assetInst.value = inst || instId.value || null
  asset.value = (await sqlInsightApi.asset(id, { instanceId: assetInst.value || undefined })).data
  assetCore.value = asset.value?.IS_CORE == 1
  assetVisible.value = true
  if (assetInst.value) { await nextTick(); loadTrend() }
}
async function loadTrend() {
  if (!asset.value || !assetInst.value) return
  const d = (await sqlInsightApi.trend(asset.value.ASSET_ID, { instanceId: assetInst.value, metric: trendMetric.value, hours: trendHours.value })).data
  await nextTick()
  if (!trendEl.value) return
  if (!chart) chart = echarts.init(trendEl.value)
  const pts = d.points || []
  const now = new Date()
  const slot = ((now.getDay() === 0 || now.getDay() === 6) ? 'WE' : 'WD')
  const bl = (d.baselines || []).find((b) => b.DAY_TYPE === slot && Number(b.HOUR_OF_DAY) === now.getHours()) || (d.baselines || []).find((b) => b.DAY_TYPE === 'R24')
  const metricIdx = METRICS.findIndex((m) => m.key === trendMetric.value)
  chart.setOption({
    tooltip: { trigger: 'axis' },
    grid: { left: 50, right: 20, top: 20, bottom: 30 },
    xAxis: { type: 'category', data: pts.map((p) => fmt(p.T)) },
    yAxis: { type: 'value', scale: true },
    series: [{
      type: 'line', name: d.label, showSymbol: false, data: pts.map((p) => p.V),
      markLine: bl ? { symbol: 'none', lineStyle: { type: 'dashed' }, data: [{ yAxis: Number(bl.MEDIAN_VAL), name: '基线' }] } : undefined,
    }, {
      type: 'scatter', name: '命中', symbolSize: 6, itemStyle: { color: '#f56c6c' },
      data: pts.map((p) => ((Number(p.ANOMALY_FLAGS || 0) & (1 << metricIdx)) ? p.V : null)),
    }],
  }, true)
}
async function saveCore(v) {
  await sqlInsightApi.updateAsset(asset.value.ASSET_ID, { isCore: v })
  ElMessage.success(v ? '已标记为核心 SQL（下次基线刷新时纳入重点 SQL）' : '已取消核心标记')
}

// ---------- 波动详情
const anomalyVisible = ref(false)
const anomaly = ref(null)
const diagnosing = ref(false)
async function openAnomaly(id) {
  anomaly.value = (await sqlInsightApi.anomaly(id)).data
  anomalyVisible.value = true
}
async function runDiagnose() {
  diagnosing.value = true
  try { await sqlInsightApi.diagnose(anomaly.value.ANOMALY_ID); await openAnomaly(anomaly.value.ANOMALY_ID) } finally { diagnosing.value = false }
}
async function acceptBaseline() {
  const { value } = await ElMessageBox.prompt('确认当前水平为预期（如业务量增长、已评估的计划变化）？基线将从现在开始重新积累。', '接受为新基线', { inputPlaceholder: '备注（可选）' })
  await sqlInsightApi.accept(anomaly.value.ANOMALY_ID, { note: value })
  ElMessage.success('已接受为新基线')
  anomalyVisible.value = false
  loadAnomalies()
}
async function resolveAnomaly() {
  await sqlInsightApi.resolveAnomaly(anomaly.value.ANOMALY_ID)
  anomalyVisible.value = false
  loadAnomalies()
}
async function resolveProblem(row) {
  await sqlInsightApi.resolveProblem(row.PROBLEM_ID)
  loadProblems()
}

// ---------- 规则
const ruleDialog = ref(false)
const ruleForm = reactive({ ruleCode: '', ruleName: '', scopeType: 'GLOBAL', scopeValue: '', enabled: true, severity: '', params: '' })
function editRule(row) {
  Object.assign(ruleForm, { ruleCode: row.RULE_CODE, ruleName: row.RULE_NAME, scopeType: row.SCOPE_TYPE, scopeValue: row.SCOPE_VALUE === '*' ? '' : row.SCOPE_VALUE, enabled: row.ENABLED == 1, severity: row.SEVERITY || '', params: row.PARAMS || '' })
  ruleDialog.value = true
}
async function saveRule() {
  if (ruleForm.params) { try { JSON.parse(ruleForm.params) } catch { return ElMessage.warning('参数必须是合法 JSON') } }
  saving.value = true
  try {
    await sqlInsightApi.saveRule({ ...ruleForm, params: ruleForm.params || undefined, severity: ruleForm.severity || undefined })
    ruleDialog.value = false
    ElMessage.success('已保存（1 分钟内生效）')
    loadRules()
  } finally { saving.value = false }
}
async function deleteRule(row) {
  await ElMessageBox.confirm(`删除 ${row.RULE_CODE} 在 ${row.SCOPE_TYPE}=${row.SCOPE_VALUE} 的覆盖？`, '确认')
  await sqlInsightApi.deleteRule(row.RULE_ID)
  loadRules()
}

// ---------- 变更窗口
const cwDialog = ref(false)
const cwForm = reactive({ windowType: 'RELEASE', title: '', instanceId: null, range: null })
async function saveWindow() {
  if (!cwForm.range) return ElMessage.warning('请选择时间')
  saving.value = true
  try {
    await sqlInsightApi.addChangeWindow({ windowType: cwForm.windowType, title: cwForm.title, instanceId: cwForm.instanceId, startTime: Number(cwForm.range[0]), endTime: Number(cwForm.range[1]) })
    cwDialog.value = false
    loadWindows(1)
  } finally { saving.value = false }
}
async function deleteWindow(row) {
  await ElMessageBox.confirm(`删除变更窗口「${row.TITLE}」？`, '确认')
  await sqlInsightApi.deleteChangeWindow(row.WINDOW_ID)
  loadWindows()
}

/** 规则优化（规则优先）；页面上还可一键交给 AI 深度优化 */
function toAiOpt(sql, inst) {
  if (!sql) return
  router.push({ path: '/sql', query: { tab: 'rule', sql: String(sql).slice(0, 4000), instanceId: inst || undefined } })
}

/** AI 只解读诊断快照、给出解释和建议，不改变规则判定的原因（设计方案 6.3） */
function toAiExplain(a) {
  const d = (a.diagnosis || [])[0]
  if (!d) return
  const prompt = `以下是 SQL 洞察对一次 SQL 性能波动的诊断结果（原因由规则判定，请不要更改原因结论）。请用通俗的语言解释证据之间的关系，并补充可操作的排查和优化步骤：\n${d.REPORT_TEXT || ''}`
  router.push({ path: '/sql', query: { tab: 'ai', sql: String(a.SAMPLE_SQL || '').slice(0, 4000), prompt: prompt.slice(0, 2000) } })
}

const reviewers = ref([])
const ticketDialog = ref(false)
const ticketSubmitting = ref(false)
const ticketPayload = ref(null)
const ticketForm = reactive({ assignedTo: null, note: '' })

async function loadReviewers() {
  if (!canOps.value) return
  try {
    const r = await sqlReviewApi.reviewers()
    reviewers.value = r.data || []
  } catch { reviewers.value = [] }
}

function openTicketDialog(body) {
  ticketPayload.value = { ...body }
  ticketForm.assignedTo = null
  ticketForm.note = ''
  ticketDialog.value = true
}

async function submitInsightTicket() {
  if (!ticketPayload.value) return
  ticketSubmitting.value = true
  const body = {
    ...ticketPayload.value,
    assignedTo: ticketForm.assignedTo || undefined,
    note: ticketForm.note || undefined,
  }
  try {
    const r = await sqlInsightApi.createTicket(body)
    ElMessage.success(r.msg || `已生成工单 #${r.data?.ticketId}`)
    ticketDialog.value = false
    const tid = r.data?.ticketId
    if (tid && r.data?.created) {
      try {
        await ElMessageBox.confirm(`已生成工单 #${tid}，是否打开 SQL 评审详情？`, '提示', { confirmButtonText: '打开', cancelButtonText: '留在此页', type: 'success' })
        router.push({ path: '/sql-review', query: { ticketId: tid } })
      } catch { /* 留在此页 */ }
    }
    if (body.anomalyId) await openAnomaly(body.anomalyId)
    else await loadProblems()
  } catch (e) {
    ElMessage.error(e?.message || '生成工单失败')
  } finally {
    ticketSubmitting.value = false
  }
}

// ---------- 执行计划变化
const plans = ref({})
const planHours = ref(24)
async function loadPlans() {
  loading.plans = true
  try { plans.value = (await sqlInsightApi.planChanges({ instanceId: instId.value || undefined, hours: planHours.value })).data || {} } catch (e) { onLoadError(e) } finally { loading.plans = false }
}

watch(() => props.instanceId, (v) => { if (v) { instId.value = Number(v); reloadAll() } })
const onResize = () => chart && chart.resize()
onMounted(async () => {
  window.addEventListener('resize', onResize)
  await Promise.all([loadInstances(), loadRules(), loadReviewers()])
  reloadAll()
  if (route.query.anomalyId) openAnomaly(route.query.anomalyId)
  if (route.query.assetId) openAsset(Number(route.query.assetId), route.query.instanceId ? Number(route.query.instanceId) : null)
})
onBeforeUnmount(() => { window.removeEventListener('resize', onResize); chart && chart.dispose() })
watch(assetVisible, (v) => { if (!v && chart) { chart.dispose(); chart = null } })
</script>

<style scoped>
.sql-insight { display: flex; flex-direction: column; gap: 12px; }
.svc-alert :deep(.el-alert__description) { white-space: normal; line-height: 1.6; }
.toolbar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; padding: 10px 14px; }
.toolbar-left { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.toolbar-right { font-size: 12px; }
.stat-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 12px; }
.stat { text-align: center; padding: 14px 0; }
.stat-num { font-size: 26px; font-weight: 600; }
.danger { color: #f56c6c; }
.warning { color: #e6a23c; }
.grid-2 { display: grid; grid-template-columns: 1.4fr 1fr; gap: 12px; }
.filters { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
.pager { margin-top: 10px; justify-content: flex-end; }
.asset-head { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
.sql-box { background: var(--el-fill-color-light, #f5f7fa); padding: 10px; border-radius: 4px; max-height: 180px; overflow: auto; white-space: pre-wrap; word-break: break-all; font-size: 12px; }
.trend { height: 260px; width: 100%; }
.actions { margin: 12px 0; display: flex; gap: 8px; flex-wrap: wrap; }
.cause { padding: 6px 0; border-bottom: 1px dashed var(--el-border-color-lighter, #ebeef5); }
.cause ul { margin: 4px 0 0 18px; padding: 0; font-size: 12px; }
.skipped { max-height: 150px; overflow: auto; }
@media (max-width: 1200px) { .stat-row { grid-template-columns: repeat(3, 1fr); } .grid-2 { grid-template-columns: 1fr; } }
</style>
