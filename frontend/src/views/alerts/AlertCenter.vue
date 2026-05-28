<template>
  <div class="page-container">
    <!-- 统计卡片 -->
    <el-row :gutter="16" class="mb-16">
      <el-col :span="4" v-for="c in statCards" :key="c.label">
        <div class="alert-stat-card" :style="{ borderLeftColor: c.color }">
          <div class="stat-num" :style="{ color: c.color }">{{ c.val }}</div>
          <div class="stat-lbl">{{ c.label }}</div>
        </div>
      </el-col>
    </el-row>

    <el-row :gutter="16">
      <!-- 告警列表 -->
      <el-col :span="16">
        <div class="card">
          <div class="card-title" style="justify-content:space-between">
            <span><el-icon><Bell /></el-icon> 告警记录</span>
            <div class="flex-center gap-8">
              <el-select v-model="q.status" placeholder="状态" clearable size="small" style="width:110px" @change="load">
                <el-option label="未处理" value="OPEN" />
                <el-option label="已确认" value="ACKNOWLEDGED" />
                <el-option label="已解决" value="RESOLVED" />
                <el-option label="已抑制" value="SUPPRESSED" />
                <el-option label="已静默" value="SILENCED" />
              </el-select>
              <el-select v-model="q.severity" placeholder="级别" clearable size="small" style="width:100px" @change="load">
                <el-option v-for="s in ['P1','P2','P3','P4']" :key="s" :label="s" :value="s" />
              </el-select>
              <el-button size="small" icon="Refresh" @click="load">刷新</el-button>
            </div>
          </div>
          <el-table :data="alerts" stripe border size="small" v-loading="loading" height="520">
            <el-table-column label="级别" width="70">
              <template #default="{ row }">
                <span :class="`badge-${row.SEVERITY?.toLowerCase()}`">{{ row.SEVERITY }}</span>
              </template>
            </el-table-column>
            <el-table-column label="优先级" width="70">
              <template #default="{ row }">
                <span v-if="priorityMap[row.ALERT_ID]" :style="{ color: priorityColor(priorityMap[row.ALERT_ID].PRIORITY_LEVEL), fontWeight: 600, fontSize: '12px' }">
                  {{ priorityMap[row.ALERT_ID].PRIORITY_SCORE }}
                </span>
                <span v-else style="color:#c0c4cc">-</span>
              </template>
            </el-table-column>
            <el-table-column prop="RULE_NAME"    label="规则名"  width="120" show-overflow-tooltip />
            <el-table-column prop="INSTANCE_NAME" label="实例"  width="110" />
            <el-table-column prop="CONTENT"      label="告警内容" min-width="200" show-overflow-tooltip />
            <el-table-column label="状态" width="80">
              <template #default="{ row }">
                <el-tag :type="statusType(row.STATUS)" size="small">{{ statusLabel(row.STATUS) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="触发时间" width="140" prop="TRIGGER_TIME" :formatter="(r,c,v)=>fmt(v)" />
            <el-table-column label="AI" width="120">
              <template #default="{ row }">
                <div style="display:flex;gap:2px;flex-wrap:wrap">
                  <el-button link type="primary" size="small" :loading="rcaLoadingMap[row.ALERT_ID]" @click="runRcaFromAlert(row)">RCA</el-button>
                  <el-button link type="warning" size="small" :loading="anomalyLoadingMap[row.INSTANCE_ID]" @click="runAnomalyFromAlert(row)">异常</el-button>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="160" fixed="right">
              <template #default="{ row }">
                <el-button v-if="row.STATUS==='OPEN'" link type="primary" size="small" @click="ack(row)">确认</el-button>
                <el-button v-if="row.STATUS==='SUPPRESSED'" link type="warning" size="small" @click="unsuppressAlert(row)">解除</el-button>
                <el-button v-if="row.STATUS==='SILENCED'" link type="warning" size="small" @click="unsilenceAlert(row)">取消静默</el-button>
                <el-button v-if="row.STATUS!=='RESOLVED'" link type="success" size="small" @click="resolve(row)">解决</el-button>
                <el-button link size="small" @click="viewAlert(row)">详情</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div style="padding:12px 0;text-align:right">
            <el-pagination v-model:current-page="page" :page-size="20" :total="total"
              layout="total,prev,pager,next" @current-change="load" small />
          </div>
        </div>
      </el-col>

      <!-- 右侧面板 -->
      <el-col :span="8">
        <!-- Tab 切换 -->
        <div class="card">
          <div class="card-title" style="justify-content:space-between">
            <div style="display:flex;gap:12px;align-items:center">
              <span :class="{'tab-active': rightTab==='rules'}" style="cursor:pointer" @click="rightTab='rules'">告警规则</span>
              <span :class="{'tab-active': rightTab==='suppression'}" style="cursor:pointer" @click="rightTab='suppression'; loadSuppressionRules()">抑制规则</span>
              <span :class="{'tab-active': rightTab==='ai'}" style="cursor:pointer" @click="rightTab='ai'; loadAiData()">AI分析</span>
              <span :class="{'tab-active': rightTab==='agg'}" style="cursor:pointer" @click="rightTab='agg'; loadAggData()">聚合去重</span>
              <span :class="{'tab-active': rightTab==='silence'}" style="cursor:pointer" @click="rightTab='silence'; loadSilenceData()">告警静默</span>
            </div>
            <el-button v-if="rightTab==='rules' || rightTab==='suppression'" size="small" type="primary" icon="Plus" @click="rightTab==='rules' ? (ruleDialog=true) : (supRuleDialog=true)">新增规则</el-button>
            <el-button v-else-if="rightTab==='agg'" size="small" type="primary" :loading="aggRunning" @click="runAggregation">执行聚合</el-button>
            <el-button v-else-if="rightTab==='silence'" size="small" type="primary" icon="Plus" @click="openSilenceDialog()">新增静默</el-button>
          </div>

          <!-- 告警规则表 -->
          <el-table v-show="rightTab==='rules'" :data="rules" stripe size="small" height="320" v-loading="rulesLoading">
            <el-table-column prop="RULE_NAME" label="规则名" min-width="120" show-overflow-tooltip />
            <el-table-column label="级别" width="65">
              <template #default="{ row }">
                <span :class="`badge-${row.SEVERITY?.toLowerCase()}`">{{ row.SEVERITY }}</span>
              </template>
            </el-table-column>
            <el-table-column label="启用" width="60">
              <template #default="{ row }">
                <el-switch v-model="row.ENABLED" :active-value="1" :inactive-value="0"
                  size="small" @change="toggleRule(row)" />
              </template>
            </el-table-column>
          </el-table>

          <!-- 抑制规则表 -->
          <el-table v-show="rightTab==='suppression'" :data="supRules" stripe size="small" height="320" v-loading="supRulesLoading">
            <el-table-column prop="RULE_NAME" label="规则名" min-width="110" show-overflow-tooltip />
            <el-table-column label="类型" width="70">
              <template #default="{ row }">
                <el-tag size="small" :type="supTypeTag(row.RULE_TYPE)">{{ supTypeLabel(row.RULE_TYPE) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="启用" width="50">
              <template #default="{ row }">
                <el-switch v-model="row.ENABLED" :active-value="1" :inactive-value="0"
                  size="small" @change="toggleSupRule(row)" />
              </template>
            </el-table-column>
            <el-table-column label="操作" width="50">
              <template #default="{ row }">
                <el-button link type="danger" size="small" @click="deleteSupRule(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>

          <!-- AI 分析面板 -->
          <div v-show="rightTab==='ai'" style="max-height:320px;overflow-y:auto">
            <div style="display:flex;gap:8px;margin-bottom:12px">
              <el-button size="small" type="primary" :loading="clusterRunning" @click="runCluster">聚类分析</el-button>
              <el-button size="small" @click="loadAiData">刷新</el-button>
            </div>
            <!-- 聚类结果 -->
            <div v-if="clusterResults.length" style="margin-bottom:12px">
              <div style="font-size:13px;font-weight:600;margin-bottom:6px">告警聚类 ({{ clusterResults.length }})</div>
              <div v-for="c in clusterResults" :key="c.CLUSTER_ID" style="padding:8px;margin-bottom:6px;background:#f5f7fa;border-radius:4px;font-size:12px">
                <div style="display:flex;justify-content:space-between;align-items:center">
                  <span style="font-weight:600">簇 #{{ c.CLUSTER_ID }}</span>
                  <el-tag size="small" type="danger">{{ c.ALERT_COUNT }}条</el-tag>
                </div>
                <div style="color:#909399;margin-top:4px">相似度: {{ (c.SIMILARITY_AVG * 100).toFixed(0) }}%</div>
                <div style="margin-top:4px;color:#606266;line-height:1.4">{{ c.CLUSTER_REASON?.substring(0, 80) }}</div>
              </div>
            </div>
            <div v-else-if="!aiLoading" style="text-align:center;color:#909399;padding:20px;font-size:13px">
              暂无聚类结果，点击「聚类分析」开始
            </div>
            <!-- 最近 RCA -->
            <div v-if="rcaResults.length" style="margin-top:12px">
              <div style="font-size:13px;font-weight:600;margin-bottom:6px">最近 RCA 分析</div>
              <div v-for="r in rcaResults.slice(0, 5)" :key="r.RCA_ID" style="padding:6px;margin-bottom:4px;background:#f5f7fa;border-radius:4px;font-size:12px;cursor:pointer" @click="openRcaDetail(r.RCA_ID)">
                <div style="display:flex;justify-content:space-between">
                  <span style="font-weight:500">{{ r.ROOT_CAUSE?.substring(0, 40) }}...</span>
                  <el-tag size="small" :type="r.CONFIDENCE >= 70 ? 'success' : r.CONFIDENCE >= 40 ? 'warning' : 'info'">{{ r.CONFIDENCE }}%</el-tag>
                </div>
                <div style="color:#909399;margin-top:2px">实例 #{{ r.INSTANCE_ID }} · {{ fmt(r.ANALYSIS_TIME) }}</div>
              </div>
            </div>
          </div>

          <!-- 聚合去重面板 -->
          <div v-show="rightTab==='agg'" style="max-height:320px;overflow-y:auto">
            <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center">
              <el-input-number v-model="aggWindow" :min="1" :max="60" size="small" style="width:120px" />
              <span style="font-size:12px;color:#909399">分钟窗口</span>
              <el-button size="small" type="primary" :loading="aggRunning" @click="runAggregation">执行聚合</el-button>
              <el-button size="small" @click="loadAggData">刷新</el-button>
            </div>
            <!-- 聚合组列表 -->
            <div v-if="aggGroups.length">
              <div v-for="g in aggGroups" :key="g.AGG_ID" style="padding:10px;margin-bottom:8px;background:#f5f7fa;border-radius:6px;font-size:12px;cursor:pointer" @click="openAggDetail(g)">
                <div style="display:flex;justify-content:space-between;align-items:center">
                  <div style="display:flex;align-items:center;gap:6px">
                    <span :class="`badge-${g.SEVERITY?.toLowerCase()}`" style="font-size:11px">{{ g.SEVERITY }}</span>
                    <span style="font-weight:600;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ g.RULE_NAME }}</span>
                  </div>
                  <el-tag size="small" type="danger">{{ g.ALERT_COUNT }}条合并</el-tag>
                </div>
                <div style="color:#909399;margin-top:4px">{{ g.INSTANCE_NAME }} · {{ fmt(g.LAST_TRIGGER) }}</div>
                <div v-if="g.REPR_CONTENT" style="margin-top:4px;color:#606266;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ g.REPR_CONTENT }}</div>
              </div>
            </div>
            <div v-else-if="!aggLoading" style="text-align:center;color:#909399;padding:20px;font-size:13px">
              暂无聚合组，点击「执行聚合」开始
            </div>
          </div>

          <!-- 告警静默面板 -->
          <div v-show="rightTab==='silence'" style="max-height:320px;overflow-y:auto">
            <div style="display:flex;gap:8px;margin-bottom:12px">
              <el-button size="small" type="primary" :loading="batchSilencing" @click="batchCheckSilence">批量静默检查</el-button>
              <el-button size="small" @click="loadSilenceData">刷新</el-button>
            </div>
            <!-- 静默规则列表 -->
            <div v-if="silenceRules.length">
              <div v-for="r in silenceRules" :key="r.RULE_ID" style="padding:10px;margin-bottom:8px;background:#f5f7fa;border-radius:6px;font-size:12px">
                <div style="display:flex;justify-content:space-between;align-items:center">
                  <div style="display:flex;align-items:center;gap:6px">
                    <el-switch v-model="r.ENABLED" :active-value="1" :inactive-value="0" size="small" @change="toggleSilenceRule(r)" />
                    <span style="font-weight:600;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ r.RULE_NAME }}</span>
                  </div>
                  <div style="display:flex;gap:4px">
                    <el-tag size="small" :type="r.SILENCE_TYPE === 'ONCE' ? '' : 'warning'">{{ r.SILENCE_TYPE === 'ONCE' ? '一次性' : '周期' }}</el-tag>
                    <el-tag v-if="r.EXPIRED" size="small" type="info">已过期</el-tag>
                    <el-button link type="danger" size="small" @click="deleteSilenceRule(r)">删除</el-button>
                  </div>
                </div>
                <div style="color:#909399;margin-top:4px">
                  <span v-if="r.SILENCE_TYPE === 'ONCE'">{{ fmt(r.START_TIME) }} ~ {{ fmt(r.END_TIME) }}</span>
                  <span v-else>{{ r.CRON_EXPR }} ({{ r.DURATION_MIN }}分钟)</span>
                </div>
                <div style="color:#606266;margin-top:2px">
                  <span v-if="r.INSTANCE_ID">实例#{{ r.INSTANCE_ID }} · </span>
                  <span v-if="r.SEVERITY">级别: {{ r.SEVERITY }} · </span>
                  <span v-if="r.RULE_NAME_MATCH">规则: {{ r.RULE_NAME_MATCH }} · </span>
                  <span>已静默 {{ r.SILENCED_COUNT || 0 }} 条</span>
                </div>
              </div>
            </div>
            <div v-else-if="!silenceLoading" style="text-align:center;color:#909399;padding:20px;font-size:13px">
              暂无静默规则，点击「新增静默」创建
            </div>
          </div>
        </div>

        <!-- 抑制统计 -->
        <div class="card" style="margin-top:16px">
          <div class="card-title" style="justify-content:space-between">
            <span><el-icon><PieChart /></el-icon> {{ rightTab==='rules' ? '未处理告警分布' : rightTab==='agg' ? '聚合概览' : rightTab==='silence' ? '静默概览' : '抑制概览' }}</span>
            <el-button v-if="rightTab==='suppression'" size="small" @click="batchCheckSup">批量检测</el-button>
          </div>
          <div v-if="rightTab==='rules'" ref="pieRef" style="height:180px"></div>
          <div v-else-if="rightTab==='agg'" style="padding:8px 0">
            <div style="display:flex;gap:12px;margin-bottom:12px">
              <div style="flex:1;text-align:center;padding:12px;background:#fff7e6;border-radius:6px">
                <div style="font-size:24px;font-weight:700;color:#fa8c16">{{ aggStatsData.activeGroups || 0 }}</div>
                <div style="font-size:12px;color:#909399">活跃聚合组</div>
              </div>
              <div style="flex:1;text-align:center;padding:12px;background:#fff1f0;border-radius:6px">
                <div style="font-size:24px;font-weight:700;color:#ff4d4f">{{ aggStatsData.totalMerged || 0 }}</div>
                <div style="font-size:12px;color:#909399">被合并告警</div>
              </div>
            </div>
            <div v-if="aggStatsData.topGroups?.length" style="font-size:12px;color:#606266">
              <div style="font-weight:600;margin-bottom:4px">合并最多的组：</div>
              <div v-for="g in aggStatsData.topGroups" :key="g.AGG_ID" style="padding:2px 0;display:flex;justify-content:space-between">
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px">{{ g.INSTANCE_NAME }} - {{ g.RULE_NAME }}</span>
                <el-tag size="small" type="danger">{{ g.ALERT_COUNT }}条</el-tag>
              </div>
            </div>
          </div>
          <div v-else-if="rightTab==='silence'" style="padding:8px 0">
            <div style="display:flex;gap:12px;margin-bottom:12px">
              <div style="flex:1;text-align:center;padding:12px;background:#f0f5ff;border-radius:6px">
                <div style="font-size:24px;font-weight:700;color:#2f54eb">{{ silenceStatsData.activeRules || 0 }}</div>
                <div style="font-size:12px;color:#909399">活跃规则</div>
              </div>
              <div style="flex:1;text-align:center;padding:12px;background:#fff7e6;border-radius:6px">
                <div style="font-size:24px;font-weight:700;color:#fa8c16">{{ silenceStatsData.silencedAlerts || 0 }}</div>
                <div style="font-size:12px;color:#909399">被静默告警</div>
              </div>
            </div>
            <div v-if="silenceStatsData.recentLogs?.length" style="font-size:12px;color:#606266">
              <div style="font-weight:600;margin-bottom:4px">最近静默：</div>
              <div v-for="l in silenceStatsData.recentLogs.slice(0,5)" :key="l.LOG_ID" style="padding:2px 0;display:flex;justify-content:space-between">
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px">{{ l.INSTANCE_NAME }} - {{ l.CONTENT?.substring(0,30) }}</span>
                <el-tag size="small">{{ l.SEVERITY }}</el-tag>
              </div>
            </div>
          </div>
          <div v-else style="padding:8px 0">
            <div style="display:flex;gap:12px;margin-bottom:12px">
              <div style="flex:1;text-align:center;padding:12px;background:#f0f9ff;border-radius:6px">
                <div style="font-size:24px;font-weight:700;color:#1890ff">{{ supStatsData.activeSuppressions || 0 }}</div>
                <div style="font-size:12px;color:#909399">活跃抑制</div>
              </div>
              <div style="flex:1;text-align:center;padding:12px;background:#f6ffed;border-radius:6px">
                <div style="font-size:24px;font-weight:700;color:#52c41a">{{ supStatsData.releasedSuppressions || 0 }}</div>
                <div style="font-size:12px;color:#909399">已解除</div>
              </div>
            </div>
            <div v-if="supStatsData.topParents?.length" style="font-size:12px;color:#606266">
              <div style="font-weight:600;margin-bottom:4px">抑制最多的父告警：</div>
              <div v-for="p in supStatsData.topParents" :key="p.PARENT_ALERT_ID" style="padding:2px 0;display:flex;justify-content:space-between">
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px">{{ p.INSTANCE_NAME }} - {{ p.CONTENT?.substring(0,30) }}</span>
                <el-tag size="small" type="danger">{{ p.CHILD_COUNT }}个子告警</el-tag>
              </div>
            </div>
          </div>
        </div>
      </el-col>
    </el-row>

    <!-- 告警详情 Dialog -->
    <el-dialog v-model="detailVisible" title="告警详情" width="540px">
      <el-descriptions v-if="current" :column="1" border size="small">
        <el-descriptions-item label="规则名">{{ current.RULE_NAME }}</el-descriptions-item>
        <el-descriptions-item label="实例">{{ current.INSTANCE_NAME }}</el-descriptions-item>
        <el-descriptions-item label="级别">
          <span :class="`badge-${current.SEVERITY?.toLowerCase()}`">{{ current.SEVERITY }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="告警内容">{{ current.CONTENT }}</el-descriptions-item>
        <el-descriptions-item label="触发时间">{{ fmt(current.TRIGGER_TIME) }}</el-descriptions-item>
        <el-descriptions-item label="状态">{{ statusLabel(current.STATUS) }}</el-descriptions-item>
        <el-descriptions-item label="确认人/时间">{{ current.ACK_BY || '-' }} {{ fmt(current.ACK_TIME) }}</el-descriptions-item>
        <el-descriptions-item label="解决人/时间">{{ current.RESOLVE_BY || '-' }} {{ fmt(current.RESOLVE_TIME) }}</el-descriptions-item>
        <el-descriptions-item v-if="current.STATUS==='SUPPRESSED'" label="抑制来源">
          <div>
            <div>{{ current.SUPPRESSION_RULE }}</div>
            <div v-if="suppressedByInfo.length" style="margin-top:4px;font-size:12px;color:#909399">
              父告警: {{ suppressedByInfo[0].PARENT_INSTANCE }} - {{ suppressedByInfo[0].PARENT_CONTENT?.substring(0,50) }}
              ({{ suppressedByInfo[0].PARENT_SEVERITY }})
            </div>
          </div>
        </el-descriptions-item>
        <el-descriptions-item v-if="current.STATUS==='SILENCED'" label="静默信息">
          <div>
            <div>静默规则 ID: {{ current.SILENCE_RULE_ID }}</div>
            <div style="margin-top:4px;font-size:12px;color:#909399">静默时间: {{ fmt(current.SILENCED_AT) }}</div>
          </div>
        </el-descriptions-item>
      </el-descriptions>
      <!-- 被此告警抑制的子告警 -->
      <div v-if="suppressingInfo.length" style="margin-top:12px">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px">此告警正在抑制 {{ suppressingInfo.length }} 个子告警：</div>
        <el-table :data="suppressingInfo" stripe size="small" max-height="160">
          <el-table-column prop="CHILD_INSTANCE" label="实例" width="120" />
          <el-table-column prop="CHILD_SEVERITY" label="级别" width="60" />
          <el-table-column prop="CHILD_CONTENT" label="内容" min-width="160" show-overflow-tooltip />
        </el-table>
      </div>
      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button v-if="current?.STATUS==='OPEN'" type="primary" @click="ack(current); detailVisible=false">确认告警</el-button>
      </template>
    </el-dialog>

    <!-- 新增规则 Dialog -->
    <el-dialog v-model="ruleDialog" title="新增告警规则" width="480px">
      <el-form :model="ruleForm" label-width="90px">
        <el-form-item label="规则名称"><el-input v-model="ruleForm.ruleName" /></el-form-item>
        <el-form-item label="监控指标"><el-input v-model="ruleForm.metric" placeholder="如: host_cpu_usage" /></el-form-item>
        <el-form-item label="条件">
          <el-select v-model="ruleForm.operator" style="width:100px">
            <el-option label=">" value="gt" /><el-option label="<" value="lt" />
            <el-option label=">=" value="gte" /><el-option label="<=" value="lte" />
          </el-select>
          <el-input-number v-model="ruleForm.threshold" style="margin-left:8px;width:130px" />
        </el-form-item>
        <el-form-item label="持续(分钟)"><el-input-number v-model="ruleForm.duration" :min="1" /></el-form-item>
        <el-form-item label="告警级别">
          <el-select v-model="ruleForm.severity">
            <el-option v-for="s in ['P1','P2','P3','P4']" :key="s" :label="s" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="适用DB类型">
          <el-select v-model="ruleForm.dbType" clearable placeholder="全部">
            <el-option label="Oracle" value="ORACLE" /><el-option label="MySQL" value="MYSQL" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="ruleDialog=false">取消</el-button>
        <el-button type="primary" :loading="savingRule" @click="saveRule">保存</el-button>
      </template>
    </el-dialog>

    <!-- 新增抑制规则 Dialog -->
    <el-dialog v-model="supRuleDialog" title="新增抑制规则" width="500px">
      <el-form :model="supRuleForm" label-width="100px">
        <el-form-item label="规则名称" required><el-input v-model="supRuleForm.ruleName" placeholder="如: 主机宕机抑制实例告警" /></el-form-item>
        <el-form-item label="抑制类型" required>
          <el-select v-model="supRuleForm.ruleType" style="width:100%">
            <el-option label="拓扑级联 (TOPOLOGY)" value="TOPOLOGY" />
            <el-option label="集群抑制 (CLUSTER)" value="CLUSTER" />
            <el-option label="级别抑制 (SEVERITY)" value="SEVERITY" />
            <el-option label="同实例抑制 (INSTANCE)" value="INSTANCE" />
          </el-select>
        </el-form-item>
        <el-form-item label="描述"><el-input v-model="supRuleForm.description" type="textarea" :rows="2" /></el-form-item>
        <el-form-item label="父告警级别">
          <el-checkbox-group v-model="supRuleForm.parentLevels">
            <el-checkbox v-for="s in ['P1','P2','P3','P4']" :key="s" :label="s" :value="s">{{ s }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="子告警级别">
          <el-checkbox-group v-model="supRuleForm.childLevels">
            <el-checkbox v-for="s in ['P1','P2','P3','P4']" :key="s" :label="s" :value="s">{{ s }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="抑制窗口(分)"><el-input-number v-model="supRuleForm.suppressWindow" :min="5" :max="1440" /></el-form-item>
        <el-form-item label="父级解决后">
          <el-switch v-model="supRuleForm.autoRelease" active-text="自动解除子告警" inactive-text="保持抑制" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="supRuleDialog=false">取消</el-button>
        <el-button type="primary" :loading="savingSupRule" @click="saveSupRule">保存</el-button>
      </template>
    </el-dialog>

    <!-- RCA 详情 Dialog -->
    <el-dialog v-model="rcaDetailVisible" title="RCA 根因分析详情" width="640px">
      <div v-if="rcaDetail" style="max-height:500px;overflow-y:auto">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="实例 ID">{{ rcaDetail.INSTANCE_ID }}</el-descriptions-item>
          <el-descriptions-item label="告警 ID">{{ rcaDetail.ALERT_ID }}</el-descriptions-item>
          <el-descriptions-item label="置信度">
            <el-tag :type="rcaDetail.CONFIDENCE >= 70 ? 'success' : rcaDetail.CONFIDENCE >= 40 ? 'warning' : 'info'">{{ rcaDetail.CONFIDENCE }}%</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="分析时间">{{ fmt(rcaDetail.ANALYSIS_TIME) }}</el-descriptions-item>
        </el-descriptions>
        <div style="margin-top:12px">
          <div style="font-weight:600;margin-bottom:6px">根因结论</div>
          <div style="padding:12px;background:#f5f7fa;border-radius:6px;line-height:1.6;font-size:13px;white-space:pre-wrap">{{ rcaDetail.ROOT_CAUSE }}</div>
        </div>
        <div v-if="rcaDetail.RECOMMENDATIONS" style="margin-top:12px">
          <div style="font-weight:600;margin-bottom:6px">处理建议</div>
          <div style="padding:12px;background:#f0f9ff;border-radius:6px;line-height:1.6;font-size:13px;white-space:pre-wrap">{{ rcaDetail.RECOMMENDATIONS }}</div>
        </div>
        <div v-if="rcaDetail.PROPAGATION_PATH" style="margin-top:12px">
          <div style="font-weight:600;margin-bottom:6px">拓扑传播路径</div>
          <el-steps :active="99" align-center style="margin:8px 0">
            <el-step v-for="(p, i) in parseJsonSafe(rcaDetail.PROPAGATION_PATH)" :key="i" :title="p.layer || p.name || `层级${i+1}`" :description="p.detail || p.value || ''" />
          </el-steps>
        </div>
        <div v-if="rcaDetail.ANOMALY_POINTS" style="margin-top:12px">
          <div style="font-weight:600;margin-bottom:6px">异常指标点</div>
          <el-table :data="parseJsonSafe(rcaDetail.ANOMALY_POINTS)" stripe size="small" max-height="180">
            <el-table-column prop="metric" label="指标" min-width="100" />
            <el-table-column prop="value" label="实际值" width="80" />
            <el-table-column prop="expected" label="期望值" width="80" />
            <el-table-column label="Z-Score" width="80">
              <template #default="{ row }">
                <el-tag :type="row.z_score > 3 ? 'danger' : row.z_score > 2 ? 'warning' : 'info'" size="small">{{ row.z_score?.toFixed(2) }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>
      <template #footer>
        <el-button @click="rcaDetailVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 聚合组详情 Dialog -->
    <el-dialog v-model="aggDetailVisible" title="聚合组详情" width="680px">
      <div v-if="aggDetail">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="聚合键">
            <code style="font-size:12px">{{ aggDetail.AGG_KEY }}</code>
          </el-descriptions-item>
          <el-descriptions-item label="严重度">
            <span :class="`badge-${aggDetail.SEVERITY?.toLowerCase()}`">{{ aggDetail.SEVERITY }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="规则名">{{ aggDetail.RULE_NAME }}</el-descriptions-item>
          <el-descriptions-item label="实例">{{ aggDetail.INSTANCE_NAME }}</el-descriptions-item>
          <el-descriptions-item label="合并告警数">{{ aggDetail.ALERT_COUNT }}</el-descriptions-item>
          <el-descriptions-item label="窗口">{{ aggDetail.WINDOW_MINUTES }} 分钟</el-descriptions-item>
          <el-descriptions-item label="首次触发">{{ fmt(aggDetail.FIRST_TRIGGER) }}</el-descriptions-item>
          <el-descriptions-item label="最后触发">{{ fmt(aggDetail.LAST_TRIGGER) }}</el-descriptions-item>
        </el-descriptions>
        <div style="margin-top:12px">
          <div style="font-weight:600;margin-bottom:8px">成员告警 ({{ aggDetail.members?.length || 0 }})</div>
          <el-table :data="aggDetail.members" stripe size="small" max-height="280">
            <el-table-column label="级别" width="60">
              <template #default="{ row }">
                <span :class="`badge-${row.SEVERITY?.toLowerCase()}`" style="font-size:11px">{{ row.SEVERITY }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="CONTENT" label="告警内容" min-width="200" show-overflow-tooltip />
            <el-table-column label="状态" width="70">
              <template #default="{ row }">
                <el-tag :type="statusType(row.STATUS)" size="small">{{ statusLabel(row.STATUS) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="角色" width="70">
              <template #default="{ row }">
                <el-tag :type="row.IS_MERGED ? 'info' : 'success'" size="small">{{ row.IS_MERGED ? '已合并' : '代表' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="触发时间" width="140" :formatter="(r,c,v)=>fmt(v)" prop="TRIGGER_TIME" />
          </el-table>
        </div>
      </div>
      <template #footer>
        <el-button @click="aggDetailVisible = false">关闭</el-button>
        <el-button type="warning" @click="splitAggGroup" :loading="aggSplitting">解散聚合</el-button>
        <el-button type="success" @click="resolveAggGroup" :loading="aggResolving">批量解决</el-button>
      </template>
    </el-dialog>

    <!-- 新增静默规则 Dialog -->
    <el-dialog v-model="silenceDialogVisible" title="新增静默规则" width="560px" :close-on-click-modal="false">
      <el-form :model="silenceForm" label-width="100px">
        <el-form-item label="规则名称" required>
          <el-input v-model="silenceForm.ruleName" placeholder="如: 计划维护窗口-实例1" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="silenceForm.description" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="静默类型">
          <el-radio-group v-model="silenceForm.silenceType">
            <el-radio value="ONCE">一次性</el-radio>
            <el-radio value="RECURRING">周期性</el-radio>
          </el-radio-group>
        </el-form-item>
        <!-- 一次性 -->
        <template v-if="silenceForm.silenceType === 'ONCE'">
          <el-form-item label="开始时间" required>
            <el-date-picker v-model="silenceForm.startTime" type="datetime" style="width:100%" />
          </el-form-item>
          <el-form-item label="结束时间" required>
            <el-date-picker v-model="silenceForm.endTime" type="datetime" style="width:100%" />
          </el-form-item>
        </template>
        <!-- 周期性 -->
        <template v-else>
          <el-form-item label="Cron 表达式" required>
            <el-input v-model="silenceForm.cronExpr" placeholder="0 2 * * 1-5" />
            <div style="font-size:11px;color:#909399;margin-top:2px">格式: 分 时 日 月 周 (如 "0 2 * * 1-5" = 工作日凌晨2点)</div>
          </el-form-item>
          <el-form-item label="持续(分钟)" required>
            <el-input-number v-model="silenceForm.durationMin" :min="1" :max="1440" />
          </el-form-item>
        </template>
        <el-form-item label="绑定实例">
          <el-select v-model="silenceForm.instanceId" clearable filterable placeholder="全部实例" style="width:100%">
            <el-option v-for="inst in instanceList" :key="inst.INSTANCE_ID"
              :label="`${inst.INSTANCE_NAME} (${inst.DB_TYPE})`" :value="inst.INSTANCE_ID" />
          </el-select>
        </el-form-item>
        <el-form-item label="告警级别">
          <el-checkbox-group v-model="silenceForm.severityList">
            <el-checkbox v-for="s in ['P1','P2','P3','P4']" :key="s" :label="s" :value="s">{{ s }}</el-checkbox>
          </el-checkbox-group>
          <div style="font-size:11px;color:#909399">不选=全部级别</div>
        </el-form-item>
        <el-form-item label="匹配规则名">
          <el-input v-model="silenceForm.ruleNameMatch" placeholder="留空=匹配所有规则" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="silenceDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="silenceSaving" @click="saveSilenceRule">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, nextTick } from 'vue'
import { alertApi, aiApi } from '@/api/index.js'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as echarts from 'echarts'

const alerts  = ref([]); const loading = ref(false)
const rules   = ref([]); const rulesLoading = ref(false)
const page    = ref(1);  const total   = ref(0)
const q       = reactive({ status: '', severity: '' })
const statsData = ref({})
const detailVisible = ref(false); const current = ref(null)
const ruleDialog    = ref(false); const savingRule = ref(false)
const pieRef = ref()

// F-17 告警抑制
const rightTab = ref('rules')
const supRules = ref([]); const supRulesLoading = ref(false)
const supRuleDialog = ref(false); const savingSupRule = ref(false)
const supStatsData = ref({})
const suppressedByInfo = ref([])
const suppressingInfo = ref([])
const supRuleForm = reactive({
  ruleName: '', ruleType: 'TOPOLOGY', description: '',
  parentLevels: ['P1', 'P2'], childLevels: ['P2', 'P3', 'P4'],
  suppressWindow: 60, autoRelease: true
})

// F-20/22 AI 告警分析
const aiLoading = ref(false)
const rcaLoadingMap = ref({})
const anomalyLoadingMap = ref({})
const priorityMap = ref({})
const clusterRunning = ref(false)
const clusterResults = ref([])
const rcaResults = ref([])
const rcaDetailVisible = ref(false)
const rcaDetail = ref(null)

const ruleForm = reactive({ ruleName:'', metric:'', operator:'gt', threshold:80, duration:5, severity:'P3', dbType:'' })

// F-16 告警聚合去重
const aggWindow = ref(10)
const aggRunning = ref(false)
const aggLoading = ref(false)
const aggGroups = ref([])
const aggStatsData = ref({})
const aggDetailVisible = ref(false)
const aggDetail = ref(null)
const aggSplitting = ref(false)
const aggResolving = ref(false)

// F-18 告警静默
const silenceRules = ref([])
const silenceLoading = ref(false)
const silenceStatsData = ref({})
const silenceDialogVisible = ref(false)
const silenceSaving = ref(false)
const batchSilencing = ref(false)
const instanceList = ref([])
const silenceForm = reactive({
  ruleName: '', description: '', silenceType: 'ONCE',
  startTime: null, endTime: null, cronExpr: '', durationMin: 60,
  instanceId: null, severityList: [], ruleNameMatch: ''
})

const statCards = computed(() => {
  const bs = statsData.value.byStatus || []
  const bsv = statsData.value.bySeverity || []
  const get = (k, arr, field='STATUS') => arr.find(r => r[field] === k)?.CNT || 0
  return [
    { label: '未处理', val: get('OPEN', bs),         color: '#ff4d4f' },
    { label: '已静默', val: get('SILENCED', bs),     color: '#2f54eb' },
    { label: '已抑制', val: get('SUPPRESSED', bs),   color: '#909399' },
    { label: 'P1紧急', val: get('P1', bsv, 'SEVERITY'), color: '#cf1322' },
    { label: 'P2严重', val: get('P2', bsv, 'SEVERITY'), color: '#fa541c' },
    { label: '已解决', val: get('RESOLVED', bs),     color: '#52c41a' },
  ]
})

function statusType(s) { return { OPEN:'danger', ACKNOWLEDGED:'warning', RESOLVED:'success', SUPPRESSED:'info', SILENCED:'' }[s] || 'info' }
function statusLabel(s) { return { OPEN:'未处理', ACKNOWLEDGED:'已确认', RESOLVED:'已解决', SUPPRESSED:'已抑制', SILENCED:'已静默' }[s] || s }
function fmt(v) { return v ? new Date(v).toLocaleString('zh-CN') : '-' }

async function load() {
  loading.value = true
  try {
    const r = await alertApi.list({ ...q, page: page.value, size: 20 })
    if (r.code === 200) { alerts.value = r.data.list || []; total.value = r.data.total || 0 }
  } finally { loading.value = false }
  loadSmartPriority()
}

async function loadStats() {
  try {
    const r = await alertApi.stats()
    if (r.code === 200) { statsData.value = r.data; initPie() }
  } catch {}
}

async function loadRules() {
  rulesLoading.value = true
  try { const r = await alertApi.rules(); rules.value = r.data || [] }
  finally { rulesLoading.value = false }
}

async function ack(row) {
  try { await alertApi.ack(row.ALERT_ID); ElMessage.success('已确认'); load(); loadStats() }
  catch (e) { ElMessage.error(e.message || '确认失败') }
}
async function resolve(row) {
  try { await alertApi.resolve(row.ALERT_ID); ElMessage.success('已解决'); load(); loadStats() }
  catch (e) { ElMessage.error(e.message || '解决失败') }
}
function viewAlert(row) {
  current.value = row; detailVisible.value = true
  suppressedByInfo.value = []; suppressingInfo.value = []
  if (row.STATUS === 'SUPPRESSED' || row.SUPPRESSED_BY_ID) loadSuppressionInfo(row.ALERT_ID)
  if (row.STATUS !== 'SUPPRESSED') loadSuppressionInfo(row.ALERT_ID)
}

async function toggleRule(row) {
  try {
    await alertApi.updateRule(row.RULE_ID, { ...row, enabled: row.ENABLED })
    ElMessage.success(row.ENABLED ? '已启用' : '已禁用')
  } catch (e) { ElMessage.error(e.message || '操作失败'); row.ENABLED = row.ENABLED ? 0 : 1 }
}

// ─── F-17 告警抑制 ──────────────────────────────────────────
function supTypeLabel(t) { return { TOPOLOGY: '拓扑', CLUSTER: '集群', SEVERITY: '级别', INSTANCE: '实例' }[t] || t }
function supTypeTag(t) { return { TOPOLOGY: 'danger', CLUSTER: 'warning', SEVERITY: '', INSTANCE: 'info' }[t] || 'info' }

async function loadSuppressionRules() {
  supRulesLoading.value = true
  try {
    const r = await alertApi.suppressionRules()
    if (r.code === 200) supRules.value = r.data || []
  } finally { supRulesLoading.value = false }
}

async function loadSuppressionStats() {
  try {
    const r = await alertApi.suppressionStats()
    if (r.code === 200) supStatsData.value = r.data || {}
  } catch {}
}

async function saveSupRule() {
  if (!supRuleForm.ruleName) return ElMessage.warning('请填写规则名称')
  savingSupRule.value = true
  try {
    await alertApi.createSuppressionRule({
      ...supRuleForm,
      parentLevels: supRuleForm.parentLevels.join(','),
      childLevels: supRuleForm.childLevels.join(',')
    })
    ElMessage.success('创建成功')
    supRuleDialog.value = false
    loadSuppressionRules()
  } catch (e) { ElMessage.error(e.message) }
  finally { savingSupRule.value = false }
}

async function toggleSupRule(row) {
  try {
    await alertApi.updateSuppressionRule(row.RULE_ID, { enabled: row.ENABLED })
    ElMessage.success(row.ENABLED ? '已启用' : '已禁用')
  } catch (e) { ElMessage.error(e.message || '操作失败'); row.ENABLED = row.ENABLED ? 0 : 1 }
}

async function deleteSupRule(row) {
  try {
    await ElMessageBox.confirm(`确定删除抑制规则 "${row.RULE_NAME}"？`, '删除确认', { type: 'warning' })
  } catch { return }
  try {
    await alertApi.deleteSuppressionRule(row.RULE_ID)
    ElMessage.success('删除成功')
    loadSuppressionRules()
  } catch (e) { ElMessage.error(e.message) }
}

async function unsuppressAlert(row) {
  try {
    await ElMessageBox.confirm('确定手动解除此告警的抑制状态？', '解除抑制', { type: 'warning' })
  } catch { return }
  try {
    await alertApi.unsuppress(row.ALERT_ID, { reason: '手动解除' })
    ElMessage.success('抑制已解除')
    load(); loadStats(); loadSuppressionStats()
  } catch (e) { ElMessage.error(e.message) }
}

async function batchCheckSup() {
  try {
    const r = await alertApi.batchCheckSuppression()
    ElMessage.success(r.msg || '批量检测完成')
    load(); loadStats(); loadSuppressionStats()
  } catch (e) { ElMessage.error(e.message) }
}

async function loadSuppressionInfo(alertId) {
  try {
    const [byRes, supRes] = await Promise.all([
      alertApi.suppressedBy(alertId),
      alertApi.suppressing(alertId)
    ])
    suppressedByInfo.value = byRes.data || []
    suppressingInfo.value = supRes.data || []
  } catch {
    suppressedByInfo.value = []
    suppressingInfo.value = []
  }
}

// ─── F-20/22 AI 告警分析 ─────────────────────────────────────
function priorityColor(level) { return { CRITICAL: '#ff4d4f', HIGH: '#fa541c', MEDIUM: '#faad14', LOW: '#52c41a' }[level] || '#909399' }
function parseJsonSafe(json) { try { return typeof json === 'string' ? JSON.parse(json) : json || [] } catch { return [] } }

async function loadSmartPriority() {
  try {
    const ids = alerts.value.map(a => a.ALERT_ID).filter(Boolean)
    if (!ids.length) return
    const r = await alertApi.smartPriority({ alertIds: ids.join(',') })
    if (r.code === 200) {
      const map = {}
      for (const p of r.data || []) map[p.ALERT_ID] = p
      priorityMap.value = map
    }
  } catch {}
}

async function runRcaFromAlert(row) {
  if (!row.INSTANCE_ID) return ElMessage.warning('该告警无关联实例')
  rcaLoadingMap.value = { ...rcaLoadingMap.value, [row.ALERT_ID]: true }
  try {
    const r = await aiApi.rca({ alert_id: row.ALERT_ID, instance_id: row.INSTANCE_ID, alert_content: row.CONTENT || '' })
    ElMessage.success(r.msg || 'RCA 分析完成')
    openRcaDetail(r.data?.rca_id)
    loadRcaResults()
  } catch (e) { ElMessage.error(e.message || 'RCA 分析失败') }
  finally { rcaLoadingMap.value = { ...rcaLoadingMap.value, [row.ALERT_ID]: false } }
}

async function runAnomalyFromAlert(row) {
  if (!row.INSTANCE_ID) return ElMessage.warning('该告警无关联实例')
  anomalyLoadingMap.value = { ...anomalyLoadingMap.value, [row.INSTANCE_ID]: true }
  try {
    const r = await aiApi.anomalyDetect({ instance_id: row.INSTANCE_ID, lookback_minutes: 60 })
    ElMessage.success(r.msg || '异常检测完成')
    rightTab.value = 'ai'
  } catch (e) { ElMessage.error(e.message || '异常检测失败') }
  finally { anomalyLoadingMap.value = { ...anomalyLoadingMap.value, [row.INSTANCE_ID]: false } }
}

async function runCluster() {
  clusterRunning.value = true
  try {
    const r = await aiApi.cluster({ similarity_threshold: 0.75 })
    ElMessage.success(r.msg || '聚类分析完成')
    await loadClusters()
  } catch (e) { ElMessage.error(e.message || '聚类失败') }
  finally { clusterRunning.value = false }
}

async function loadClusters() {
  try { const r = await aiApi.clusterList({ limit: 20 }); clusterResults.value = r.data || [] } catch {}
}

async function loadRcaResults() {
  try { const r = await aiApi.rcaList({ limit: 20 }); rcaResults.value = r.data || [] } catch {}
}

async function openRcaDetail(rcaId) {
  if (!rcaId) return
  try {
    const r = await aiApi.rcaDetail(rcaId)
    rcaDetail.value = r.data || r
    rcaDetailVisible.value = true
  } catch (e) { ElMessage.error(e.message || '获取 RCA 详情失败') }
}

async function loadAiData() {
  aiLoading.value = true
  try { await Promise.all([loadClusters(), loadRcaResults()]) }
  finally { aiLoading.value = false }
}

// ─── F-16 告警聚合去重 ──────────────────────────────────────
async function runAggregation() {
  aggRunning.value = true
  try {
    const r = await alertApi.aggregate({ windowMinutes: aggWindow.value })
    ElMessage.success(r.msg || '聚合完成')
    await loadAggData()
    load(); loadStats()
  } catch (e) { ElMessage.error(e.message) }
  finally { aggRunning.value = false }
}

async function loadAggGroups() {
  aggLoading.value = true
  try {
    const r = await alertApi.aggGroups({ status: 'ACTIVE', size: 50 })
    aggGroups.value = r.data?.list || r.data?.rows || r.data || []
  } catch { aggGroups.value = [] }
  finally { aggLoading.value = false }
}

async function loadAggStats() {
  try {
    const r = await alertApi.aggGroupStats()
    if (r.code === 200) aggStatsData.value = r.data || {}
  } catch {}
}

async function loadAggData() {
  await Promise.all([loadAggGroups(), loadAggStats()])
}

async function openAggDetail(g) {
  try {
    const r = await alertApi.aggGroupDetail(g.AGG_ID)
    aggDetail.value = r.data || {}
    aggDetailVisible.value = true
  } catch (e) { ElMessage.error(e.message) }
}

async function splitAggGroup() {
  if (!aggDetail.value) return
  try { await ElMessageBox.confirm('解散后被合并的告警将恢复为独立状态', '解散确认', { type: 'warning' }) } catch { return }
  aggSplitting.value = true
  try {
    await alertApi.aggGroupSplit(aggDetail.value.AGG_ID)
    ElMessage.success('聚合组已解散')
    aggDetailVisible.value = false
    await loadAggData()
    load(); loadStats()
  } catch (e) { ElMessage.error(e.message) }
  finally { aggSplitting.value = false }
}

async function resolveAggGroup() {
  if (!aggDetail.value) return
  try { await ElMessageBox.confirm(`确定解决该聚合组内的 ${aggDetail.value.ALERT_COUNT} 条告警？`, '批量解决', { type: 'warning' }) } catch { return }
  aggResolving.value = true
  try {
    await alertApi.aggGroupResolve(aggDetail.value.AGG_ID)
    ElMessage.success('批量解决成功')
    aggDetailVisible.value = false
    await loadAggData()
    load(); loadStats()
  } catch (e) { ElMessage.error(e.message) }
  finally { aggResolving.value = false }
}

// ─── F-18 告警静默 ───────────────────────────────────────────
async function loadSilenceRules() {
  silenceLoading.value = true
  try {
    const r = await alertApi.silenceRules()
    if (r.code === 200) silenceRules.value = r.data || []
  } catch { silenceRules.value = [] }
  finally { silenceLoading.value = false }
}

async function loadSilenceStats() {
  try {
    const r = await alertApi.silenceStats()
    if (r.code === 200) silenceStatsData.value = r.data || {}
  } catch {}
}

async function loadSilenceData() {
  await Promise.all([loadSilenceRules(), loadSilenceStats()])
  loadInstancesForSilence()
}

async function loadInstancesForSilence() {
  try {
    const r = await alertApi.list({ size: 1 })
    // Use the existing instance data from the alert list
    // We'll fetch instances from cmdbApi if available
  } catch {}
}

function openSilenceDialog() {
  Object.assign(silenceForm, {
    ruleName: '', description: '', silenceType: 'ONCE',
    startTime: null, endTime: null, cronExpr: '', durationMin: 60,
    instanceId: null, severityList: [], ruleNameMatch: ''
  })
  silenceDialogVisible.value = true
  // Load instances for the dropdown
  loadSilenceInstances()
}

async function loadSilenceInstances() {
  try {
    const { cmdbApi } = await import('@/api/index.js')
    const r = await cmdbApi.list({ size: 500 })
    instanceList.value = r.data?.list || r.data?.rows || r.data || []
  } catch { instanceList.value = [] }
}

async function saveSilenceRule() {
  if (!silenceForm.ruleName) return ElMessage.warning('规则名称必填')
  if (silenceForm.silenceType === 'ONCE' && (!silenceForm.startTime || !silenceForm.endTime))
    return ElMessage.warning('请设置开始和结束时间')
  if (silenceForm.silenceType === 'RECURRING' && (!silenceForm.cronExpr || !silenceForm.durationMin))
    return ElMessage.warning('请设置 Cron 表达式和持续时长')

  silenceSaving.value = true
  try {
    const d = {
      ...silenceForm,
      severity: silenceForm.severityList.length ? silenceForm.severityList.join(',') : null,
      startTime: silenceForm.startTime ? new Date(silenceForm.startTime).toISOString() : null,
      endTime: silenceForm.endTime ? new Date(silenceForm.endTime).toISOString() : null,
    }
    await alertApi.createSilenceRule(d)
    ElMessage.success('创建成功')
    silenceDialogVisible.value = false
    await loadSilenceData()
  } catch (e) { ElMessage.error(e.message) }
  finally { silenceSaving.value = false }
}

async function toggleSilenceRule(row) {
  try {
    await alertApi.updateSilenceRule(row.RULE_ID, { enabled: row.ENABLED })
    ElMessage.success(row.ENABLED ? '已启用' : '已禁用')
  } catch (e) { ElMessage.error(e.message); row.ENABLED = row.ENABLED ? 0 : 1 }
}

async function deleteSilenceRule(row) {
  try { await ElMessageBox.confirm(`确定删除静默规则「${row.RULE_NAME}」？`, '删除确认', { type: 'warning' }) } catch { return }
  try {
    await alertApi.deleteSilenceRule(row.RULE_ID)
    ElMessage.success('已删除')
    await loadSilenceData()
  } catch (e) { ElMessage.error(e.message) }
}

async function batchCheckSilence() {
  batchSilencing.value = true
  try {
    const r = await alertApi.batchCheckSilence()
    ElMessage.success(r.msg || '批量静默检查完成')
    load(); loadStats(); loadSilenceStats()
  } catch (e) { ElMessage.error(e.message) }
  finally { batchSilencing.value = false }
}

async function unsilenceAlert(row) {
  try { await ElMessageBox.confirm('确定取消此告警的静默状态？', '取消静默', { type: 'warning' }) } catch { return }
  try {
    await alertApi.unsilence(row.ALERT_ID)
    ElMessage.success('静默已取消')
    load(); loadStats(); loadSilenceStats()
  } catch (e) { ElMessage.error(e.message) }
}

async function saveRule() {
  savingRule.value = true
  try {
    await alertApi.createRule(ruleForm)
    ElMessage.success('规则创建成功')
    ruleDialog.value = false; loadRules()
  } finally { savingRule.value = false }
}

function initPie() {
  nextTick(() => {
    if (!pieRef.value) return
    const c = echarts.getInstanceByDom(pieRef.value) || echarts.init(pieRef.value)
    const bsv = statsData.value.bySeverity || []
    c.setOption({
      backgroundColor: 'transparent',
      textStyle: { color: '#909399' },
      tooltip: { trigger: 'item' },
      series: [{ type: 'pie', radius: '65%',
        data: ['P1','P2','P3','P4'].map(s => ({
          name: s, value: bsv.find(r => r.SEVERITY === s)?.CNT || 0,
          itemStyle: { color: { P1:'#ff4d4f', P2:'#fa541c', P3:'#faad14', P4:'#52c41a' }[s] }
        })),
      }],
    })
  })
}

onMounted(() => { load(); loadStats(); loadRules(); loadSuppressionStats(); loadSuppressionRules(); loadAiData(); loadAggData(); loadSilenceData() })
</script>

<style scoped>
.alert-stat-card {
  background: var(--agent-panel-bg, #ffffff);
  border: 1px solid var(--agent-border, #e4e7ed);
  border-radius: 8px;
  padding: 16px 20px;
  border-left: 4px solid;
  box-shadow: none;
}
.stat-num { font-size: 28px; font-weight: 700; color: var(--agent-text, #303133); }
.stat-lbl { font-size: 13px; color: var(--agent-text-muted, #909399); margin-top: 4px; }
.tab-active { color: var(--el-color-primary, #409eff); font-weight: 600; border-bottom: 2px solid var(--el-color-primary, #409eff); padding-bottom: 2px; }
</style>
