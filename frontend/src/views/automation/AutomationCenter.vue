<template>
  <div class="auto-pro-wrap">
    <!-- 左侧导航 -->
    <aside class="auto-sidebar">
      <div class="auto-sidebar-title">自动化运维</div>
      <el-menu :default-active="activeModule" @select="switchModule" class="auto-nav">
        <el-menu-item index="inspect"><el-icon><Search /></el-icon><span>自动巡检</span></el-menu-item>
        <el-menu-item index="fault"><el-icon><Warning /></el-icon><span>故障自动处理</span></el-menu-item>
        <el-menu-item index="publish"><el-icon><Promotion /></el-icon><span>自动发布</span></el-menu-item>
        <el-menu-item index="sql"><el-icon><DataAnalysis /></el-icon><span>SQL治理中心</span></el-menu-item>
        <el-menu-item index="ha"><el-icon><Connection /></el-icon><span>高可用与容灾</span></el-menu-item>
        <el-menu-item index="capacity"><el-icon><TrendCharts /></el-icon><span>容量预测</span></el-menu-item>
        <el-menu-item index="backup"><el-icon><FolderOpened /></el-icon><span>备份恢复中心</span></el-menu-item>
      </el-menu>
    </aside>

    <!-- 右侧内容区 -->
    <div class="auto-content">

      <!-- ══════ 1. 自动巡检 ══════ -->
      <div v-if="activeModule==='inspect'">
        <el-tabs v-model="inspectTab" type="card">
          <!-- 脚本库 -->
          <el-tab-pane label="巡检脚本库" name="scripts">
            <div class="toolbar">
              <el-select v-model="scriptFilter.dbType" placeholder="数据库类型" clearable style="width:130px" @change="() => loadScripts()">
                <el-option v-for="t in dbTypes" :key="t" :label="t" :value="t"/>
              </el-select>
              <el-button type="primary" plain native-type="button" :loading="scriptsLoading" @click.prevent.stop="refreshScriptLibrary">
                <el-icon class="el-icon--left"><Refresh /></el-icon>
                刷新
              </el-button>
              <el-button v-if="canMutate" type="primary" @click="openScriptDlg()">新建脚本</el-button>
              <el-button v-if="canMutate" type="success" @click="uploadScriptVisible=true">上传脚本文件</el-button>
              <el-dropdown v-if="canMutate" trigger="click" @command="downloadInspectLocalTemplate">
                <el-button>下载模版<el-icon class="el-icon--right"><ArrowDown/></el-icon></el-button>
                <template #dropdown>
                  <el-dropdown-menu popper-class="inspect-template-download-menu">
                    <el-dropdown-item
                      v-for="(tpl, ti) in inspectDownloadTemplates"
                      :key="tpl.fileName + '-' + ti"
                      :command="tpl.fileName"
                    >
                      <span class="inspect-tpl-line1">{{ tpl.fileName }}</span>
                    </el-dropdown-item>
                    <el-dropdown-item v-if="!inspectDownloadTemplates.length" disabled>
                      <span class="inspect-tpl-line1">本地模版目录暂无文件</span>
                      <span class="inspect-tpl-line2">请将文件放入服务端配置的目录后刷新</span>
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
            <el-table v-loading="scriptsLoading" element-loading-text="加载中…" :data="scripts" size="small" stripe>
              <el-table-column prop="SCRIPT_NAME" label="脚本名称" min-width="160"/>
              <el-table-column prop="DB_TYPE" label="DB类型" width="100"><template #default="{row}"><el-tag size="small">{{row.DB_TYPE}}</el-tag></template></el-table-column>
              <el-table-column prop="VERSION" label="版本" width="70"/>
              <el-table-column prop="IS_TEMPLATE" label="模板" width="60"><template #default="{row}">{{row.IS_TEMPLATE?'是':'否'}}</template></el-table-column>
              <el-table-column prop="ENABLED" label="启用" width="60"><template #default="{row}"><el-tag :type="row.ENABLED?'success':'info'" size="small">{{row.ENABLED?'是':'否'}}</el-tag></template></el-table-column>
              <el-table-column v-if="canMutate" label="操作" width="120">
                <template #default="{row}">
                  <el-button link type="primary" @click="openScriptDlg(row)">编辑</el-button>
                  <el-button link type="danger" @click="deleteScript(row.SCRIPT_ID)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-tab-pane>

          <!-- 巡检任务 -->
          <el-tab-pane label="巡检任务" name="tasks">
            <div class="toolbar">
              <el-button @click="loadTasks" :icon="Refresh">刷新</el-button>
              <el-button v-if="canMutate" type="primary" @click="openTaskDlg()">新建任务</el-button>
            </div>
            <el-table :data="inspectTasks" size="small" stripe>
              <el-table-column prop="TASK_NAME" label="任务名称" min-width="140"/>
              <el-table-column prop="DB_TYPE" label="DB类型" width="90"/>
              <el-table-column prop="CRON_EXPR" label="Cron" width="130"/>
              <el-table-column prop="STATUS" label="状态" width="90"><template #default="{row}"><el-tag :type="taskStatusColor(row.STATUS)" size="small">{{row.STATUS}}</el-tag></template></el-table-column>
              <el-table-column prop="LAST_RUN_AT" label="最近执行" width="160"><template #default="{row}">{{fmtTime(row.LAST_RUN_AT)}}</template></el-table-column>
              <el-table-column v-if="canMutate" label="操作" width="150">
                <template #default="{row}">
                  <el-button link type="primary" :loading="runningTask===row.TASK_ID" @click="runTask(row.TASK_ID)">立即巡检</el-button>
                  <el-button link type="danger" :disabled="runningTask===row.TASK_ID" @click="deleteInspectTask(row.TASK_ID)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-tab-pane>

          <!-- 巡检报告（5类） -->
          <el-tab-pane v-for="cat in reportCategories" :key="cat.v" :label="cat.l" :name="'rpt_'+cat.v">
            <div class="toolbar">
              <el-select v-model="reportFilter.instanceId" placeholder="选择实例" clearable style="width:180px" @change="loadReports(cat.v)">
                <el-option v-for="i in instances" :key="i.INSTANCE_ID" :label="i.INSTANCE_NAME" :value="i.INSTANCE_ID"/>
              </el-select>
              <el-button @click="loadReports(cat.v)" :icon="Refresh">刷新</el-button>
            </div>
            <el-table :data="reportMap[cat.v]||[]" size="small" stripe>
              <el-table-column prop="INSTANCE_NAME" label="实例" min-width="120"/>
              <el-table-column prop="DB_TYPE" label="DB类型" width="90"/>
              <el-table-column prop="OVERALL_SCORE" label="评分" width="70"><template #default="{row}"><span :class="scoreClass(row.OVERALL_SCORE)">{{row.OVERALL_SCORE}}</span></template></el-table-column>
              <el-table-column prop="OVERALL_STATUS" label="状态" width="90"><template #default="{row}"><el-tag :type="statusColor(row.OVERALL_STATUS)" size="small">{{row.OVERALL_STATUS}}</el-tag></template></el-table-column>
              <el-table-column prop="SUMMARY" label="摘要" min-width="200" show-overflow-tooltip>
                <template #default="{row}">{{ reportSummaryText(row) }}</template>
              </el-table-column>
              <el-table-column prop="CREATED_AT" label="巡检时间" width="160"><template #default="{row}">{{fmtTime(row.CREATED_AT)}}</template></el-table-column>
              <el-table-column label="报告" width="130">
                <template #default="{row}">
                  <el-button link type="primary" @click="viewReport(row)">查看</el-button>
                  <el-button link type="success" @click="downloadReportDocx(row)">Word</el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </div>

      <!-- ══════ 2. 故障自动处理 ══════ -->
      <div v-if="activeModule==='fault'">
        <!-- 7日故障大盘摘要 -->
        <div v-if="faultDashboard" class="fault-dashboard-bar">
          <div v-for="s in (faultDashboard.statusSummary||[])" :key="s.STATUS" class="dashboard-stat">
            <div class="ds-value" :style="{color:s.STATUS==='SUCCESS'?'#52c41a':s.STATUS==='FAILED'?'#ff4d4f':'#faad14'}">{{s.CNT}}</div>
            <div class="ds-label">{{s.STATUS==='SUCCESS'?'7日成功':s.STATUS==='FAILED'?'7日失败':'7日跳过'}}</div>
          </div>
          <div class="dashboard-stat">
            <div class="ds-value" style="color:#1677ff">{{faultDashboard.haFailoverCount||0}}</div>
            <div class="ds-label">关联HA切换</div>
          </div>
          <div class="dashboard-stat">
            <div class="ds-value">{{faultDashboard.avgResolutionSec||0}}s</div>
            <div class="ds-label">平均处理耗时</div>
          </div>
          <div v-if="(faultDashboard.topFaultTypes||[]).length" style="margin-left:auto;font-size:12px;color:var(--el-text-color-secondary)">
            高发故障：<el-tag v-for="t in faultDashboard.topFaultTypes.slice(0,3)" :key="t.FAULT_TYPE" type="danger" size="small" style="margin-left:4px">{{faultTypeLabel(t.FAULT_TYPE)}}({{t.CNT}})</el-tag>
          </div>
        </div>
        <el-tabs v-model="faultTab" type="card">
          <el-tab-pane label="故障策略配置" name="policies">
            <div class="toolbar">
              <el-select v-model="faultFilter.dbType" placeholder="DB类型" clearable style="width:120px" @change="loadFaultPolicies">
                <el-option v-for="t in dbTypes" :key="t" :label="t" :value="t"/>
              </el-select>
              <el-button native-type="button" :loading="faultPoliciesLoading" @click.prevent.stop="refreshFaultPolicies">
                <el-icon class="el-icon--left"><Refresh /></el-icon>刷新
              </el-button>
              <el-button v-if="canMutate" type="primary" @click="openFaultDlg()">新建策略</el-button>
            </div>
            <el-table v-loading="faultPoliciesLoading" :data="faultPolicies" size="small" stripe>
              <el-table-column prop="POLICY_NAME" label="策略名称" min-width="160"/>
              <el-table-column prop="DB_TYPE" label="数据库" width="90"><template #default="{row}"><el-tag size="small">{{row.DB_TYPE}}</el-tag></template></el-table-column>
              <el-table-column prop="FAULT_TYPE" label="故障类型" width="180"><template #default="{row}"><el-tag type="danger" size="small">{{faultTypeLabel(row.FAULT_TYPE)}}</el-tag></template></el-table-column>
              <el-table-column prop="ACTION_TYPE" label="处理方式" width="130">
                <template #default="{row}">
                  <el-tag :type="row.ACTION_TYPE==='AUTO_FIX'?'success':row.ACTION_TYPE==='HA_FAILOVER'?'danger':'warning'" size="small">
                    {{actionTypeLabel(row.ACTION_TYPE)}}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="ENABLED" label="启用" width="60"><template #default="{row}"><el-switch :model-value="!!row.ENABLED" disabled/></template></el-table-column>
              <el-table-column v-if="canMutate" label="操作" width="210">
                <template #default="{row}">
                  <el-button link type="primary" @click="openFaultDlg(row)">编辑</el-button>
                  <el-button link type="success" @click="openTriggerDlg(row)">手动触发</el-button>
                  <el-button link type="danger" @click="deleteFaultPolicy(row.POLICY_ID)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-tab-pane>
          <el-tab-pane label="执行历史" name="faultlogs">
            <div class="toolbar">
              <el-select v-model="faultLogFilter.status" placeholder="状态" clearable style="width:110px" @change="loadFaultLogs">
                <el-option label="成功" value="SUCCESS"/><el-option label="失败" value="FAILED"/><el-option label="跳过" value="SKIPPED"/>
              </el-select>
              <el-select v-model="faultLogFilter.faultType" placeholder="故障类型" clearable style="width:160px" @change="loadFaultLogs">
                <el-option v-for="(label,key) in faultTypeMap" :key="key" :label="label" :value="key"/>
              </el-select>
              <el-button native-type="button" :loading="faultLogsLoading" @click.prevent.stop="refreshFaultLogs">
                <el-icon class="el-icon--left"><Refresh /></el-icon>刷新
              </el-button>
            </div>
            <el-table v-loading="faultLogsLoading" :data="faultLogs" size="small" stripe>
              <el-table-column prop="INSTANCE_NAME" label="实例" min-width="120"/>
              <el-table-column prop="FAULT_TYPE" label="故障类型" width="170"><template #default="{row}">{{faultTypeLabel(row.FAULT_TYPE)}}</template></el-table-column>
              <el-table-column prop="ACTION_TYPE" label="处理方式" width="110">
                <template #default="{row}">
                  <el-tag :type="row.ACTION_TYPE==='HA_FAILOVER'?'danger':'success'" size="small">{{actionTypeLabel(row.ACTION_TYPE)}}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="TRIGGER_SOURCE" label="触发源" width="100"/>
              <el-table-column prop="STATUS" label="状态" width="80">
                <template #default="{row}">
                  <el-tag :type="row.STATUS==='SUCCESS'?'success':row.STATUS==='SKIPPED'?'info':'danger'" size="small">{{row.STATUS}}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="关联HA" width="90">
                <template #default="{row}">
                  <el-tag v-if="row.HA_CORRELATION_ID" type="danger" size="small" style="cursor:pointer"
                    @click="switchModule('ha');haTab='switches'">拓扑{{row.HA_CORRELATION_ID}}</el-tag>
                  <span v-else>-</span>
                </template>
              </el-table-column>
              <el-table-column prop="DETAIL" label="处理详情" min-width="200" show-overflow-tooltip/>
              <el-table-column prop="CREATED_AT" label="时间" width="160"><template #default="{row}">{{fmtTime(row.CREATED_AT)}}</template></el-table-column>
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </div>

      <!-- ══════ 3. 自动发布 ══════ -->
      <div v-if="activeModule==='publish'">
        <el-tabs v-model="publishTab" type="card">
          <el-tab-pane label="发布工单" name="tickets">
            <div class="toolbar">
              <el-select v-model="ticketFilter.status" placeholder="状态" clearable style="width:120px" @change="loadTickets">
                <el-option v-for="s in ticketStatuses" :key="s.v" :label="s.l" :value="s.v"/>
              </el-select>
              <el-select v-model="ticketFilter.ticketType" placeholder="类型" clearable style="width:120px" @change="loadTickets">
                <el-option label="SQL发布" value="SQL_PUBLISH"/><el-option label="DDL审核" value="DDL_REVIEW"/>
              </el-select>
              <el-select v-model="ticketFilter.env" placeholder="环境" clearable style="width:90px" @change="loadTickets">
                <el-option label="PROD" value="PROD"/><el-option label="STAGING" value="STAGING"/><el-option label="DEV" value="DEV"/>
              </el-select>
              <el-button @click="loadTickets" :icon="Refresh">刷新</el-button>
              <el-button type="primary" @click="newTicketVisible=true">新建工单</el-button>
            </div>
            <el-table :data="tickets" size="small" stripe>
              <el-table-column prop="TICKET_NO" label="工单号" width="170"/>
              <el-table-column prop="TITLE" label="标题" min-width="150" show-overflow-tooltip/>
              <el-table-column prop="TICKET_TYPE" label="类型" width="85"><template #default="{row}"><el-tag size="small">{{row.TICKET_TYPE==='SQL_PUBLISH'?'SQL发布':'DDL审核'}}</el-tag></template></el-table-column>
              <el-table-column label="环境" width="70">
                <template #default="{row}">
                  <el-tag :type="row.ENV==='PROD'?'danger':row.ENV==='STAGING'?'warning':'info'" size="small">{{row.ENV||'PROD'}}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="INSTANCE_NAME" label="实例" width="110"/>
              <el-table-column prop="RISK_LEVEL" label="风险" width="80"><template #default="{row}"><el-tag :type="riskColor(row.RISK_LEVEL)" size="small">{{row.RISK_LEVEL}}</el-tag></template></el-table-column>
              <el-table-column label="状态/进度" width="140">
                <template #default="{row}">
                  <el-tag :type="ticketStatusColor(row.STATUS)" size="small">{{ticketStatusLabel(row.STATUS)}}</el-tag>
                  <el-progress v-if="row.STATUS==='GRAY_TESTING'" :percentage="row.GRAY_PERCENT||0" :stroke-width="4" style="width:60px;display:inline-block;margin-left:4px"/>
                </template>
              </el-table-column>
              <el-table-column prop="SUBMITTER" label="提交人" width="80"/>
              <el-table-column prop="CREATED_AT" label="提交时间" width="150"><template #default="{row}">{{fmtTime(row.CREATED_AT)}}</template></el-table-column>
              <el-table-column label="操作" width="220">
                <template #default="{row}">
                  <el-button link type="primary" @click="viewTicket(row.TICKET_ID)">详情</el-button>
                  <el-button v-if="canMutate && row.STATUS==='REVIEWING'" link type="success" @click="reviewTicket(row,'APPROVE')">通过</el-button>
                  <el-button v-if="canMutate && row.STATUS==='REVIEWING'" link type="danger" @click="reviewTicket(row,'REJECT')">拒绝</el-button>
                  <el-button v-if="canMutate && row.STATUS==='APPROVED'" link type="warning" @click="openExecDlg(row)">执行</el-button>
                  <el-button v-if="canMutate && row.STATUS==='GRAY_TESTING'" link type="primary" @click="openExecDlg(row)">全量发布</el-button>
                  <el-button v-if="canMutate && ['DONE','GRAY_TESTING'].includes(row.STATUS)" link type="info" @click="rollbackTicket(row)">回滚</el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="DDL审核规则" name="ddlrules">
            <div class="toolbar">
              <el-button @click="loadDdlRules" :icon="Refresh">刷新</el-button>
              <el-button v-if="canMutate" type="primary" @click="openDdlRuleDlg()">新建规则</el-button>
              <el-alert type="info" :closable="false" style="margin-left:8px" title="审核规则动态加载，新建/修改后立即生效于 SQL 预审和工单创建" show-icon/>
            </div>
            <el-table :data="ddlRules" size="small" stripe>
              <el-table-column prop="RULE_CODE" label="规则编码" width="160"/>
              <el-table-column prop="RULE_NAME" label="规则名称" min-width="160"/>
              <el-table-column prop="DB_TYPE" label="适用DB" width="80"/>
              <el-table-column prop="SEVERITY" label="级别" width="90"><template #default="{row}"><el-tag :type="riskColor(row.SEVERITY)" size="small">{{row.SEVERITY}}</el-tag></template></el-table-column>
              <el-table-column prop="MESSAGE" label="提示信息" min-width="200" show-overflow-tooltip/>
              <el-table-column prop="ENABLED" label="启用" width="60"><template #default="{row}"><el-switch :model-value="!!row.ENABLED" @change="toggleDdlRule(row)" /></template></el-table-column>
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </div>

      <!-- ══════ 4. SQL治理中心 ══════ -->
      <div v-if="activeModule==='sql'">
        <!-- 健康概览：各实例平均得分 -->
        <div v-if="sqlHealthOverview.length" class="sql-health-bar">
          <span style="font-size:12px;color:var(--el-text-color-secondary);margin-right:8px">实例SQL健康度：</span>
          <div v-for="h in sqlHealthOverview.slice(0,5)" :key="h.INSTANCE_ID" class="health-badge">
            <span class="health-name">{{h.INSTANCE_NAME||'#'+h.INSTANCE_ID}}</span>
            <el-progress :percentage="h.AVG_SCORE||0" :color="h.AVG_SCORE>=90?'#52c41a':h.AVG_SCORE>=70?'#faad14':'#ff4d4f'" :stroke-width="6" style="width:80px"/>
            <span v-if="h.HIGH_RISK_CNT>0" style="color:#ff4d4f;font-size:11px;margin-left:4px">高风险{{h.HIGH_RISK_CNT}}条</span>
          </div>
        </div>
        <el-tabs v-model="sqlTab" type="card">
          <el-tab-pane label="SQL即时审核" name="audit">
            <div class="sql-audit-panel">
              <div class="sql-audit-left">
                <el-input v-model="auditSql" type="textarea" :rows="10" placeholder="输入 SQL 进行即时审核..." style="font-family:monospace"/>
                <div class="toolbar" style="margin-top:8px">
                  <el-select v-model="auditInstanceId" placeholder="选择实例(可选)" clearable style="width:180px">
                    <el-option v-for="i in instances" :key="i.INSTANCE_ID" :label="i.INSTANCE_NAME" :value="i.INSTANCE_ID"/>
                  </el-select>
                  <el-button type="primary" :loading="auditLoading" @click="runSqlAudit">立即审核</el-button>
                  <el-button @click="auditSql='';auditResult=null">清空</el-button>
                </div>
              </div>
              <div class="sql-audit-right" v-if="auditResult">
                <div class="score-ring" :class="scoreClass(auditResult.score)">
                  <div class="score-num">{{ auditResult.score }}</div>
                  <div class="score-label">SQL评分</div>
                </div>
                <el-tag :type="riskColor(auditResult.risk)" style="margin:8px 0">风险等级: {{ auditResult.risk }}</el-tag>
                <div v-if="auditResult.issues?.length">
                  <div v-for="(iss,i) in auditResult.issues" :key="i" class="audit-issue">
                    <el-icon :class="iss.severity==='CRITICAL'?'text-danger':iss.severity==='ERROR'?'text-warning':'text-info'"><WarningFilled/></el-icon>
                    <span><strong>[{{iss.severity}}]</strong> {{iss.message}}</span>
                  </div>
                </div>
                <el-empty v-else description="无违规，SQL质量良好 ✓" :image-size="60"/>
                <!-- 优化建议 -->
                <div v-if="auditResult.hints?.length" style="margin-top:8px">
                  <div style="font-size:12px;color:var(--el-text-color-secondary);margin-bottom:4px">优化建议</div>
                  <div v-for="(h,i) in auditResult.hints" :key="i" class="audit-hint">💡 {{h}}</div>
                </div>
                <!-- 高分SQL推送发布 -->
                <el-button v-if="auditResult.score>=85 && auditInstanceId" type="success" size="small"
                  style="margin-top:12px" @click="pushAuditToPublish">
                  一键推送至发布流程 →
                </el-button>
              </div>
            </div>
          </el-tab-pane>

          <el-tab-pane label="审核历史" name="auditHistory">
            <div class="toolbar">
              <el-select v-model="auditHistFilter.riskLevel" placeholder="风险级别" clearable style="width:120px" @change="loadAuditHistory">
                <el-option label="LOW" value="LOW"/><el-option label="MEDIUM" value="MEDIUM"/>
                <el-option label="HIGH" value="HIGH"/><el-option label="CRITICAL" value="CRITICAL"/>
              </el-select>
              <el-select v-model="auditHistFilter.source" placeholder="来源" clearable style="width:130px" @change="loadAuditHistory">
                <el-option label="手动审核" value="MANUAL"/><el-option label="故障自动" value="FAULT_AUTO"/>
                <el-option label="慢查询导入" value="SLOW_IMPORT"/><el-option label="发布预审" value="PUBLISH_PRE"/>
              </el-select>
              <el-select v-model="auditReviewFilter.reviewStatus" placeholder="人工审核状态" clearable style="width:130px" @change="loadAuditHistory">
                <el-option label="⏳ 待审核" value="PENDING"/>
                <el-option label="✅ 已确认" value="CONFIRMED"/>
                <el-option label="🚫 已忽略" value="IGNORED"/>
              </el-select>
              <el-button @click="loadAuditHistory" :icon="Refresh">刷新</el-button>
            </div>
            <el-alert type="info" :closable="false" style="margin-bottom:10px"
              title="SQL审查完成后需经人工审核确认：点击「查看/审核」可查看完整SQL与问题清单，确认有效后方可推送发布流程" show-icon/>
            <el-table :data="auditHistory" size="small" stripe>
              <el-table-column prop="INSTANCE_NAME" label="实例" width="120"/>
              <el-table-column prop="SQL_PREVIEW" label="SQL预览" min-width="180" show-overflow-tooltip/>
              <el-table-column prop="SCORE" label="评分" width="65"><template #default="{row}"><span :class="scoreClass(row.SCORE)">{{row.SCORE}}</span></template></el-table-column>
              <el-table-column prop="RISK_LEVEL" label="风险" width="85"><template #default="{row}"><el-tag :type="riskColor(row.RISK_LEVEL)" size="small">{{row.RISK_LEVEL}}</el-tag></template></el-table-column>
              <el-table-column prop="SOURCE" label="来源" width="95"><template #default="{row}"><el-tag size="small" type="info">{{auditSourceLabel(row.SOURCE)}}</el-tag></template></el-table-column>
              <el-table-column label="人工审核" width="85">
                <template #default="{row}">
                  <el-tag size="small"
                    :type="row.REVIEW_STATUS==='CONFIRMED'?'success':row.REVIEW_STATUS==='IGNORED'?'info':'warning'">
                    {{row.REVIEW_STATUS==='CONFIRMED'?'已确认':row.REVIEW_STATUS==='IGNORED'?'已忽略':'待审核'}}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="CREATED_AT" label="时间" width="150"><template #default="{row}">{{fmtTime(row.CREATED_AT)}}</template></el-table-column>
              <el-table-column label="操作" width="160">
                <template #default="{row}">
                  <el-button link type="primary" size="small" @click="openAuditDetail(row)">查看/审核</el-button>
                  <el-button
                    v-if="row.REVIEW_STATUS==='CONFIRMED' && ['LOW','MEDIUM'].includes(row.RISK_LEVEL)"
                    link type="success" size="small" @click="pushAuditRecordToPublish(row)">推送发布</el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="慢查询导入" name="slowQuery">
            <div class="toolbar">
              <el-select v-model="slowQueryInstanceId" placeholder="选择实例" style="width:180px">
                <el-option v-for="i in instances" :key="i.INSTANCE_ID" :label="i.INSTANCE_NAME" :value="i.INSTANCE_ID"/>
              </el-select>
              <el-button type="primary" :loading="importingSlowQuery" @click="importSlowQueries">从监控导入慢查询</el-button>
              <el-alert type="info" :closable="false" style="margin-left:8px"
                title="从监控指标(slow_query_text)自动导入并审核，结果进入审核历史，高风险SQL不可直接发布" show-icon/>
            </div>
          </el-tab-pane>

          <el-tab-pane label="评分维度配置" name="scoreConfig">
            <div class="toolbar"><el-button @click="loadScoreConfig" :icon="Refresh">刷新</el-button></div>
            <el-table :data="scoreConfig" size="small" stripe>
              <el-table-column prop="DIMENSION" label="评分维度" width="120"/>
              <el-table-column prop="DESCRIPTION" label="说明" min-width="160"/>
              <el-table-column prop="WEIGHT" label="权重(%)" width="120">
                <template #default="{row}">
                  <el-input-number v-if="canMutate" v-model="row.WEIGHT" :min="0" :max="100" size="small" @change="updateScoreWeight(row)"/>
                  <span v-else>{{row.WEIGHT}}%</span>
                </template>
              </el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="SQL基线管理" name="baseline">
            <div class="toolbar">
              <el-button @click="loadBaselines" :icon="Refresh">刷新</el-button>
              <el-button v-if="canMutate" type="primary" @click="openBaselineDlg()">手动固化基线</el-button>
              <el-button v-if="canMutate" type="warning" :loading="regressionLoading" @click="runRegression">执行回归分析</el-button>
              <el-alert type="info" :closable="false" style="margin-left:8px" title="全量发布成功后，低风险SQL自动进入CANDIDATE状态，DBA确认后固化为ACTIVE" show-icon/>
            </div>
            <el-table :data="baselines" size="small" stripe>
              <el-table-column prop="SQL_HASH" label="SQL Hash" width="140"/>
              <el-table-column prop="INSTANCE_NAME" label="实例" width="120"/>
              <el-table-column prop="BASELINE_TYPE" label="类型" width="100"><template #default="{row}"><el-tag size="small">{{row.BASELINE_TYPE}}</el-tag></template></el-table-column>
              <el-table-column prop="STATUS" label="状态" width="90">
                <template #default="{row}">
                  <el-tag :type="row.STATUS==='ACTIVE'?'success':row.STATUS==='CANDIDATE'?'warning':'info'" size="small">{{row.STATUS}}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="BASELINE_SCORE" label="基线评分" width="90"><template #default="{row}"><span :class="scoreClass(row.BASELINE_SCORE)">{{row.BASELINE_SCORE||'-'}}</span></template></el-table-column>
              <el-table-column prop="SQL_TEXT" label="SQL文本" min-width="200" show-overflow-tooltip/>
              <el-table-column prop="CREATED_AT" label="固化时间" width="160"><template #default="{row}">{{fmtTime(row.CREATED_AT)}}</template></el-table-column>
              <el-table-column v-if="canMutate" label="操作" width="90">
                <template #default="{row}">
                  <el-button v-if="row.STATUS==='CANDIDATE'" link type="success" @click="activateBaseline(row)">确认激活</el-button>
                </template>
              </el-table-column>
            </el-table>
            <el-divider>回归分析结果 — 退化基线触发故障告警</el-divider>
            <el-table :data="regressions" size="small" stripe>
              <el-table-column prop="SQL_HASH" label="SQL Hash" width="140"/>
              <el-table-column prop="BASELINE_COST" label="基线评分" width="100"/>
              <el-table-column prop="CURRENT_COST" label="当前评分" width="100"/>
              <el-table-column prop="REGRESSED" label="是否退化" width="90"><template #default="{row}"><el-tag :type="row.REGRESSED?'danger':'success'" size="small">{{row.REGRESSED?'退化':'正常'}}</el-tag></template></el-table-column>
              <el-table-column prop="DETAIL" label="说明" min-width="200" show-overflow-tooltip/>
              <el-table-column prop="CHECKED_AT" label="分析时间" width="160"><template #default="{row}">{{fmtTime(row.CHECKED_AT)}}</template></el-table-column>
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </div>

      <!-- ══════ 5. 高可用与容灾 ══════ -->
      <div v-if="activeModule==='ha'">
        <!-- HA总览摘要 -->
        <div v-if="haDashboard" class="fault-dashboard-bar">
          <div class="dashboard-stat">
            <div class="ds-value" style="color:#1677ff">{{haDashboard.topoCount||0}}</div>
            <div class="ds-label">HA拓扑总数</div>
          </div>
          <div v-for="s in (haDashboard.switchStats||[]).filter(x=>x.STATUS==='SUCCESS')" :key="s.SWITCH_TYPE" class="dashboard-stat">
            <div class="ds-value" :style="{color:s.SWITCH_TYPE==='FAILOVER'?'#ff4d4f':'#52c41a'}">{{s.CNT}}</div>
            <div class="ds-label">30日{{switchTypeLabel(s.SWITCH_TYPE)}}</div>
          </div>
          <div v-for="h in (haDashboard.drHealth||[])" :key="h.LINK_STATUS" class="dashboard-stat">
            <div class="ds-value" :style="{color:h.LINK_STATUS==='NORMAL'?'#52c41a':'#ff4d4f'}">{{h.CNT}}</div>
            <div class="ds-label">DR链路{{h.LINK_STATUS}}</div>
          </div>
        </div>
        <el-tabs v-model="haTab" type="card">
          <el-tab-pane label="HA拓扑管理" name="topologies">
            <div class="toolbar">
              <el-button @click="loadTopologies" :icon="Refresh">刷新</el-button>
              <el-button v-if="canMutate" type="primary" @click="openTopoDlg()">新建拓扑</el-button>
            </div>
            <el-table :data="topologies" size="small" stripe>
              <el-table-column prop="TOPO_NAME" label="拓扑名称" min-width="150"/>
              <el-table-column prop="HA_TYPE" label="类型" width="90"><template #default="{row}"><el-tag size="small" type="warning">{{row.HA_TYPE}}</el-tag></template></el-table-column>
              <el-table-column label="主节点" width="160">
                <template #default="{row}">
                  <span>{{row.PRIMARY_NAME||'ID:'+row.PRIMARY_ID}}</span>
                  <el-tag v-if="row.PRIMARY_CMDB_STATUS&&row.PRIMARY_CMDB_STATUS!=='ACTIVE'" type="danger" size="small" style="margin-left:4px">{{row.PRIMARY_CMDB_STATUS}}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="VIP" label="VIP" width="140"/>
              <el-table-column prop="STATUS" label="状态" width="100"><template #default="{row}"><el-tag :type="topoStatusColor(row.STATUS)" size="small">{{row.STATUS}}</el-tag></template></el-table-column>
              <el-table-column v-if="canMutate" label="操作" width="240">
                <template #default="{row}">
                  <el-button link type="primary" @click="openTopoDlg(row)">编辑</el-button>
                  <el-button link type="warning" @click="openSwitchDlg(row)">一键切换</el-button>
                  <el-button link type="info" @click="doHealthCheck(row)">健康检查</el-button>
                  <el-button link @click="viewSwitchHistory(row.TOPO_ID)">切换记录</el-button>
                </template>
              </el-table-column>
            </el-table>
            <!-- 健康检查结果 -->
            <div v-if="healthCheckResult" class="health-check-panel" style="margin-top:12px">
              <div style="font-weight:600;margin-bottom:8px">拓扑 [{{healthCheckResult.topo}}] 节点健康检查结果
                <el-tag :type="healthCheckResult.safeToSwitch?'success':'danger'" style="margin-left:8px">
                  {{healthCheckResult.safeToSwitch?'✓ 可安全切换':'✗ 不建议切换'}}
                </el-tag>
              </div>
              <el-table :data="healthCheckResult.checks" size="small" stripe>
                <el-table-column prop="nodeId" label="节点ID" width="90"/>
                <el-table-column prop="instanceName" label="实例名称" min-width="140"/>
                <el-table-column prop="status" label="CMDB状态" width="100"/>
                <el-table-column label="心跳" width="90"><template #default="{row}"><el-tag :type="row.hasBeat?'success':'warning'" size="small">{{row.hasBeat?'正常':'无心跳'}}</el-tag></template></el-table-column>
                <el-table-column label="健康" width="80"><template #default="{row}"><el-tag :type="row.healthy?'success':'danger'" size="small">{{row.healthy?'健康':'异常'}}</el-tag></template></el-table-column>
              </el-table>
            </div>
          </el-tab-pane>

          <el-tab-pane label="切换记录" name="switches">
            <div class="toolbar">
              <el-select v-model="switchHistFilter.switchType" placeholder="切换类型" clearable style="width:120px" @change="loadSwitches()">
                <el-option label="计划切换" value="PLANNED"/><el-option label="故障切换" value="FAILOVER"/><el-option label="演练" value="DRILL"/>
              </el-select>
              <el-button @click="loadSwitches()" :icon="Refresh">刷新</el-button>
            </div>
            <el-table :data="switches" size="small" stripe>
              <el-table-column prop="TOPO_NAME" label="拓扑" min-width="130"/>
              <el-table-column prop="HA_TYPE" label="类型" width="80"/>
              <el-table-column prop="SWITCH_TYPE" label="切换类型" width="110"><template #default="{row}"><el-tag :type="switchTypeColor(row.SWITCH_TYPE)" size="small">{{switchTypeLabel(row.SWITCH_TYPE)}}</el-tag></template></el-table-column>
              <el-table-column prop="FROM_NODE" label="原主节点" width="90"/>
              <el-table-column prop="TO_NODE" label="新主节点" width="90"/>
              <el-table-column prop="STATUS" label="状态" width="80"><template #default="{row}"><el-tag :type="row.STATUS==='SUCCESS'?'success':'danger'" size="small">{{row.STATUS}}</el-tag></template></el-table-column>
              <el-table-column prop="OPERATOR" label="操作人" width="90"/>
              <el-table-column prop="CREATED_AT" label="时间" width="160"><template #default="{row}">{{fmtTime(row.CREATED_AT)}}</template></el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="容灾可视化" name="dr">
            <div class="toolbar">
              <el-button @click="loadDrLinks" :icon="Refresh">刷新</el-button>
              <el-button v-if="canMutate" type="primary" @click="openDrLinkDlg()">添加容灾链路</el-button>
            </div>
            <div class="dr-visual">
              <div v-for="link in drLinks" :key="link.LINK_ID" class="dr-link-card">
                <div class="dr-node dr-source">
                  <el-icon size="24"><LocationFilled/></el-icon>
                  <div class="dr-node-name">{{link.SOURCE_REGION}}</div>
                  <div class="dr-node-sub">{{link.SRC_NAME||'主实例'}}</div>
                </div>
                <div class="dr-link-line" :class="'dr-'+(link.LINK_STATUS||'unknown').toLowerCase()">
                  <div class="dr-link-info">
                    <div>{{ link.SYNC_MODE }}</div>
                    <div class="dr-delay" :class="link.SYNC_DELAY_MS>link.RPO_SEC*800?'text-warning':''">
                      延迟: {{link.SYNC_DELAY_MS}}ms
                      <el-tag v-if="link.DELAY_FROM_MONITOR" size="small" type="info" style="margin-left:4px">实时</el-tag>
                    </div>
                    <div>RPO: {{link.RPO_SEC}}s / RTO: {{link.RTO_SEC}}s</div>
                    <el-tag :type="link.LINK_STATUS==='NORMAL'?'success':'danger'" size="small">{{link.LINK_STATUS||'UNKNOWN'}}</el-tag>
                  </div>
                  <div class="dr-arrow">→</div>
                </div>
                <div class="dr-node dr-target">
                  <el-icon size="24"><LocationFilled/></el-icon>
                  <div class="dr-node-name">{{link.TARGET_REGION}}</div>
                  <div class="dr-node-sub">{{link.TGT_NAME||'备实例'}}</div>
                </div>
                <div style="margin-left:16px;display:flex;flex-direction:column;gap:4px">
                  <el-button v-if="canMutate" size="small" @click="refreshDrLink(link.LINK_ID)">刷新状态</el-button>
                  <el-button v-if="canMutate && link.SOURCE_ID && link.TARGET_ID" size="small" type="warning"
                    :loading="drillingLink===link.LINK_ID" @click="doDrDrill(link)">容灾演练</el-button>
                  <div v-if="link.LAST_DRILL_AT" style="font-size:11px;color:var(--el-text-color-secondary)">
                    上次演练: {{fmtTime(link.LAST_DRILL_AT)}}
                  </div>
                </div>
              </div>
              <el-empty v-if="!drLinks.length" description="暂无容灾链路，点击「添加容灾链路」配置"/>
            </div>
          </el-tab-pane>
        </el-tabs>
      </div>

      <!-- ══════ 6. 容量预测与成本分析 ══════ -->
      <div v-if="activeModule==='capacity'">
        <el-tabs v-model="capacityTab" type="card">
          <el-tab-pane label="容量快照" name="snapshots">
            <div class="toolbar">
              <el-select v-model="capacityInstanceId" placeholder="选择实例" clearable style="width:180px">
                <el-option v-for="i in instances" :key="i.INSTANCE_ID" :label="i.INSTANCE_NAME" :value="i.INSTANCE_ID"/>
              </el-select>
              <el-button @click="loadSnapshots" :icon="Refresh">查询</el-button>
              <el-button v-if="canMutate" type="primary" :loading="collectingSnap" @click="collectSnapshot">立即采集</el-button>
              <el-button v-if="canMutate" type="warning" :loading="forecastLoading" @click="runForecast">生成预测</el-button>
            </div>
            <el-table :data="snapshots" size="small" stripe>
              <el-table-column prop="INSTANCE_NAME" label="实例" min-width="120"/>
              <el-table-column prop="SNAP_DATE" label="日期" width="110"/>
              <el-table-column prop="DISK_USED_GB" label="磁盘已用(GB)" width="120"/>
              <el-table-column prop="DISK_TOTAL_GB" label="总容量(GB)" width="110"/>
              <el-table-column label="使用率" width="100">
                <template #default="{row}">
                  <el-progress :percentage="Math.round((row.DISK_USED_GB/row.DISK_TOTAL_GB||0)*100)" :status="(row.DISK_USED_GB/row.DISK_TOTAL_GB||0)>0.85?'exception':''" :stroke-width="6"/>
                </template>
              </el-table-column>
              <el-table-column prop="TPS_AVG" label="TPS均值" width="90"/>
              <el-table-column prop="CPU_AVG_PCT" label="CPU均值%" width="90"/>
              <el-table-column prop="CONN_AVG" label="连接数均值" width="100"/>
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="容量趋势预测" name="forecast">
            <div class="toolbar">
              <el-select v-model="capacityInstanceId" placeholder="选择实例" clearable style="width:180px">
                <el-option v-for="i in instances" :key="i.INSTANCE_ID" :label="i.INSTANCE_NAME" :value="i.INSTANCE_ID"/>
              </el-select>
              <el-button @click="loadForecasts" :icon="Refresh">查询</el-button>
            </div>
            <el-table :data="forecasts" size="small" stripe>
              <el-table-column prop="INSTANCE_NAME" label="实例" min-width="120"/>
              <el-table-column prop="METRIC_TYPE" label="预测指标" width="100"><template #default="{row}"><el-tag size="small">{{row.METRIC_TYPE==='DISK'?'磁盘(GB)':'TPS'}}</el-tag></template></el-table-column>
              <el-table-column prop="FORECAST_DATE" label="预测日期" width="110"/>
              <el-table-column prop="FORECAST_VAL" label="预测值" width="100"/>
              <el-table-column prop="CONFIDENCE" label="置信度%" width="90"/>
              <el-table-column prop="DAYS_TO_FULL" label="距满预估天数" width="120"><template #default="{row}"><span :class="row.DAYS_TO_FULL<30?'text-danger':row.DAYS_TO_FULL<60?'text-warning':''">{{row.DAYS_TO_FULL}}天</span></template></el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="成本分析" name="cost">
            <div class="toolbar">
              <el-button @click="loadCostAnalysis" :icon="Refresh">刷新</el-button>
              <el-button v-if="canMutate" type="primary" :loading="costAnalysisLoading" @click="runCostAnalysis">立即分析</el-button>
            </div>
            <el-table :data="costAnalysis" size="small" stripe>
              <el-table-column prop="INSTANCE_NAME" label="实例" min-width="120"/>
              <el-table-column prop="BUSINESS_TAG" label="业务标签" width="120"/>
              <el-table-column prop="ANALYSIS_DATE" label="分析日期" width="110"/>
              <el-table-column prop="CPU_COST_UNIT" label="CPU消耗" width="90"/>
              <el-table-column prop="IO_COST_UNIT" label="IO消耗" width="90"/>
              <el-table-column prop="WASTE_PCT" label="资源浪费率%" width="110"><template #default="{row}"><span :class="row.WASTE_PCT>30?'text-danger':row.WASTE_PCT>15?'text-warning':''">{{row.WASTE_PCT}}%</span></template></el-table-column>
              <el-table-column prop="SCORE" label="利用率评分" width="100"><template #default="{row}"><span :class="scoreClass(row.SCORE)">{{row.SCORE}}</span></template></el-table-column>
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </div>

      <!-- ══════ 7. 备份恢复中心 ══════ -->
      <div v-if="activeModule==='backup'">
        <el-tabs v-model="backupTab" type="card">
          <el-tab-pane label="备份策略" name="policies">
            <div class="toolbar">
              <el-button @click="loadBackupPolicies" :icon="Refresh">刷新</el-button>
              <el-button v-if="canMutate" type="primary" @click="openBkPolicyDlg()">新建策略</el-button>
            </div>
            <el-table :data="bkPolicies" size="small" stripe>
              <el-table-column prop="POLICY_NAME" label="策略名称" min-width="150"/>
              <el-table-column prop="INSTANCE_NAME" label="实例" width="130"/>
              <el-table-column prop="BACKUP_TYPE" label="备份类型" width="100"><template #default="{row}"><el-tag size="small" :type="bkTypeColor(row.BACKUP_TYPE)">{{bkTypeLabel(row.BACKUP_TYPE)}}</el-tag></template></el-table-column>
              <el-table-column prop="STORAGE_TYPE" label="存储类型" width="90"/>
              <el-table-column prop="RETENTION_DAYS" label="保留天数" width="90"/>
              <el-table-column prop="SCHEDULE" label="调度计划" width="130"/>
              <el-table-column prop="LAST_RUN_AT" label="最近执行" width="160"><template #default="{row}">{{fmtTime(row.LAST_RUN_AT)}}</template></el-table-column>
              <el-table-column prop="ENABLED" label="启用" width="60"><template #default="{row}"><el-tag :type="row.ENABLED?'success':'info'" size="small">{{row.ENABLED?'是':'否'}}</el-tag></template></el-table-column>
              <el-table-column v-if="canMutate" label="操作" width="160">
                <template #default="{row}">
                  <el-button link type="primary" @click="openBkPolicyDlg(row)">编辑</el-button>
                  <el-button link type="success" :loading="runningBk===row.POLICY_ID" @click="runBackupNow(row.POLICY_ID)">立即备份</el-button>
                  <el-button link type="danger" @click="deleteBkPolicy(row.POLICY_ID)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="备份记录" name="records">
            <div class="toolbar">
              <el-select v-model="bkFilter.backupType" placeholder="备份类型" clearable style="width:120px" @change="loadBkRecords">
                <el-option label="全备" value="FULL"/><el-option label="增备" value="INCREMENTAL"/>
                <el-option label="逻辑备份" value="LOGICAL"/><el-option label="物理备份" value="PHYSICAL"/>
              </el-select>
              <el-select v-model="bkFilter.status" placeholder="状态" clearable style="width:100px" @change="loadBkRecords">
                <el-option label="成功" value="SUCCESS"/><el-option label="失败" value="FAILED"/>
                <el-option label="运行中" value="RUNNING"/>
              </el-select>
              <el-button @click="loadBkRecords" :icon="Refresh">刷新</el-button>
            </div>
            <el-table :data="bkRecords" size="small" stripe>
              <el-table-column prop="INSTANCE_NAME" label="实例" min-width="120"/>
              <el-table-column prop="BACKUP_TYPE" label="类型" width="90"><template #default="{row}"><el-tag :type="bkTypeColor(row.BACKUP_TYPE)" size="small">{{bkTypeLabel(row.BACKUP_TYPE)}}</el-tag></template></el-table-column>
              <el-table-column prop="STATUS" label="状态" width="80"><template #default="{row}"><el-tag :type="bkStatusColor(row.STATUS)" size="small">{{row.STATUS}}</el-tag></template></el-table-column>
              <el-table-column prop="FILE_SIZE_MB" label="大小(MB)" width="90"/>
              <el-table-column prop="DURATION_SEC" label="耗时(s)" width="80"/>
              <el-table-column prop="TRIGGER_TYPE" label="触发方式" width="90"/>
              <el-table-column prop="FILE_PATH" label="存储路径" min-width="200" show-overflow-tooltip/>
              <el-table-column prop="CREATED_AT" label="时间" width="160"><template #default="{row}">{{fmtTime(row.CREATED_AT)}}</template></el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="备份监控统计" name="bkstats">
            <div class="toolbar"><el-button @click="loadBkStats" :icon="Refresh">刷新</el-button></div>
            <div class="stats-cards" v-if="bkStats">
              <el-card v-for="s in bkStats.statusSummary||[]" :key="s.STATUS" class="stat-card">
                <div class="stat-title">{{s.STATUS}}</div>
                <div class="stat-value" :class="s.STATUS==='FAILED'?'text-danger':'text-success'">{{s.CNT}} 次</div>
                <div class="stat-sub">均耗时 {{s.AVG_DUR}}s</div>
                <div class="stat-sub">累计 {{s.TOTAL_GB}} GB</div>
              </el-card>
            </div>
            <el-divider>近7天失败TOP实例</el-divider>
            <el-table :data="bkStats?.topFailures||[]" size="small" stripe>
              <el-table-column prop="INSTANCE_NAME" label="实例" min-width="150"/>
              <el-table-column prop="FAIL_CNT" label="失败次数" width="100"/>
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="恢复管理" name="restores">
            <div class="toolbar">
              <el-button @click="loadRestores" :icon="Refresh">刷新</el-button>
              <el-button type="primary" @click="openRestoreDlg()">新建恢复任务</el-button>
            </div>
            <el-table :data="restores" size="small" stripe>
              <el-table-column prop="INSTANCE_NAME" label="实例" min-width="120"/>
              <el-table-column prop="RESTORE_TYPE" label="恢复类型" width="110"><template #default="{row}"><el-tag size="small" type="warning">{{restoreTypeLabel(row.RESTORE_TYPE)}}</el-tag></template></el-table-column>
              <el-table-column prop="STATUS" label="状态" width="90"><template #default="{row}"><el-tag :type="bkStatusColor(row.STATUS)" size="small">{{row.STATUS}}</el-tag></template></el-table-column>
              <el-table-column prop="RESULT" label="结果详情" min-width="200" show-overflow-tooltip/>
              <el-table-column prop="OPERATOR" label="操作人" width="90"/>
              <el-table-column prop="CREATED_AT" label="创建时间" width="160"><template #default="{row}">{{fmtTime(row.CREATED_AT)}}</template></el-table-column>
              <el-table-column v-if="canMutate" label="操作" width="90">
                <template #default="{row}">
                  <el-button v-if="row.STATUS==='PENDING'" link type="success" @click="executeRestore(row.RESTORE_ID)">执行</el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </div>
    </div>

    <!-- ══════ Dialogs ══════ -->

    <!-- 巡检脚本 Dialog -->
    <el-dialog v-model="scriptDlgVisible" :title="scriptForm.scriptId?'编辑脚本':'新建巡检脚本'" width="640px">
      <el-form :model="scriptForm" label-width="90px" size="small">
        <el-form-item label="脚本名称"><el-input v-model="scriptForm.scriptName"/></el-form-item>
        <el-form-item label="DB类型">
          <el-select v-model="scriptForm.dbType"><el-option v-for="t in dbTypes" :key="t" :label="t" :value="t"/></el-select>
        </el-form-item>
        <el-form-item label="版本"><el-input v-model="scriptForm.version" style="width:100px"/></el-form-item>
        <el-form-item label="脚本内容"><el-input v-model="scriptForm.scriptContent" type="textarea" :rows="8" style="font-family:monospace;font-size:12px"/></el-form-item>
        <el-form-item label="启用"><el-switch v-model="scriptForm.enabled"/></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="scriptDlgVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveScript">保存</el-button>
      </template>
    </el-dialog>

    <!-- 上传脚本 Dialog（选文件用原生 input，避免 el-upload 在弹窗内状态异常） -->
    <el-dialog v-model="uploadScriptVisible" title="上传巡检脚本" width="480px">
      <el-form label-width="90px" size="small" @submit.prevent>
        <el-form-item label="DB类型">
          <el-select v-model="uploadForm.dbType"><el-option v-for="t in dbTypes" :key="t" :label="t" :value="t"/></el-select>
        </el-form-item>
        <el-form-item label="脚本文件" class="inspect-file-item-wrap">
          <input
            ref="uploadNativeInputRef"
            type="file"
            accept=".sql,.sh,.py"
            class="hidden-file-input"
            @change="onScriptFileInputChange"
          />
          <div class="inspect-file-row">
            <el-button type="primary" native-type="button" @click.prevent.stop="pickScriptFile">选择脚本文件</el-button>
            <span v-if="uploadScriptRawFile" class="inspect-file-name">{{ uploadScriptRawFile.name }}</span>
            <el-button v-if="uploadScriptRawFile" link type="danger" native-type="button" @click.prevent.stop="clearPickedScriptFile">清除</el-button>
          </div>
          <div class="el-upload__tip">支持 .sql / .sh / .py 格式</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button native-type="button" @click="uploadScriptVisible=false">取消</el-button>
        <el-button type="primary" native-type="button" :loading="saving" @click.prevent="doUploadScript">上传</el-button>
      </template>
    </el-dialog>

    <!-- 巡检任务 Dialog -->
    <el-dialog v-model="taskDlgVisible" title="新建巡检任务" width="560px">
      <el-form :model="taskForm" label-width="90px" size="small">
        <el-form-item label="任务名称"><el-input v-model="taskForm.taskName"/></el-form-item>
        <el-form-item label="DB类型">
          <el-select v-model="taskForm.dbType" clearable><el-option v-for="t in dbTypes" :key="t" :label="t" :value="t"/></el-select>
        </el-form-item>
        <el-form-item label="目标实例">
          <el-select v-model="taskForm.instanceIds" multiple style="width:100%">
            <el-option v-for="i in instances" :key="i.INSTANCE_ID" :label="i.INSTANCE_NAME" :value="i.INSTANCE_ID"/>
          </el-select>
        </el-form-item>
        <el-form-item label="巡检脚本">
          <el-select v-model="taskForm.scriptIds" multiple filterable collapse-tags collapse-tags-tooltip style="width:100%" placeholder="从脚本库选择（可先选 DB 类型过滤）">
            <el-option v-for="s in scriptsForTaskPicker" :key="s.SCRIPT_ID" :label="`${s.SCRIPT_NAME} [${s.CATEGORY}]`" :value="s.SCRIPT_ID"/>
          </el-select>
        </el-form-item>
        <el-form-item label="Cron表达式"><el-input v-model="taskForm.cronExpr" placeholder="0 2 * * * (每天02:00)"/></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="taskDlgVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveTask">保存</el-button>
      </template>
    </el-dialog>

    <!-- 立即巡检：执行详情（日志；有报错时突出脚本 SQL 错误） -->
    <el-dialog v-model="taskRunDetailVisible" title="巡检执行详情" width="760px" destroy-on-close>
      <el-alert
        v-if="Number(taskRunDetail.code) !== 200"
        type="error"
        :title="taskRunDetail.msg || '巡检失败'"
        show-icon
        :closable="false"
        class="task-run-alert"
      />
      <el-alert
        v-else-if="(taskRunDetail.sqlErrors || []).length"
        type="warning"
        title="巡检已完成，但部分脚本语句执行失败，请优先查看下方「脚本语句错误」"
        show-icon
        :closable="false"
        class="task-run-alert"
      />
      <template v-if="(taskRunDetail.sqlErrors || []).length">
        <div class="task-run-section-title">脚本语句错误</div>
        <el-table :data="taskRunDetail.sqlErrors" size="small" stripe max-height="240">
          <el-table-column prop="instanceName" label="实例" min-width="100" show-overflow-tooltip />
          <el-table-column prop="category" label="分类" width="96" />
          <el-table-column prop="error" label="错误" min-width="160" show-overflow-tooltip />
          <el-table-column prop="sqlPreview" label="SQL 预览" min-width="160" show-overflow-tooltip />
        </el-table>
      </template>
      <div class="task-run-section-title">执行日志</div>
      <pre class="task-run-log-pre">{{ (taskRunDetail.logs || []).join('\n') || '（无日志）' }}</pre>
      <template #footer>
        <el-button @click="taskRunDetailVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 故障策略 Dialog -->
    <el-dialog v-model="faultDlgVisible" :title="faultForm.policyId?'编辑策略':'新建故障策略'" width="560px">
      <el-form :model="faultForm" label-width="90px" size="small">
        <el-form-item label="策略名称"><el-input v-model="faultForm.policyName"/></el-form-item>
        <el-form-item label="数据库类型">
          <el-select v-model="faultForm.dbType" @change="faultForm.faultType=''">
            <el-option v-for="t in dbTypes" :key="t" :label="t" :value="t"/>
          </el-select>
        </el-form-item>
        <el-form-item label="故障类型">
          <el-select v-model="faultForm.faultType">
            <el-option v-for="ft in faultTypesFor(faultForm.dbType)" :key="ft.v" :label="ft.l" :value="ft.v"/>
          </el-select>
        </el-form-item>
        <el-form-item label="处理方式">
          <el-radio-group v-model="faultForm.actionType">
            <el-radio value="AUTO_FIX">自动修复</el-radio>
            <el-radio value="HA_FAILOVER"><span style="color:#f56c6c;font-weight:600">HA故障转移</span></el-radio>
            <el-radio value="ALERT_ONLY">仅告警</el-radio>
            <el-radio value="MANUAL">人工处理</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-alert v-if="faultForm.actionType==='HA_FAILOVER'" type="warning" :closable="false" style="margin-bottom:8px"
          title="HA故障转移将自动触发高可用切换，执行前会进行节点健康检查，请确保已配置HA拓扑" show-icon/>
        <el-form-item label="修复脚本" v-if="faultForm.actionType==='AUTO_FIX'">
          <el-input v-model="faultForm.actionScript" type="textarea" :rows="4" placeholder="自动执行的修复命令..." style="font-family:monospace;font-size:12px"/>
        </el-form-item>
        <el-form-item label="触发条件" v-if="faultForm.actionType!=='ALERT_ONLY'">
          <el-input v-model="faultForm.conditionJson" type="textarea" :rows="2" placeholder='示例: {"metric":"replication_delay","threshold":30}' style="font-family:monospace;font-size:12px"/>
        </el-form-item>
        <el-form-item label="启用"><el-switch v-model="faultForm.enabled"/></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="faultDlgVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveFaultPolicy">保存</el-button>
      </template>
    </el-dialog>

    <!-- 手动触发故障 Dialog -->
    <el-dialog v-model="triggerDlgVisible" title="手动触发故障处理" width="480px">
      <el-form label-width="90px" size="small">
        <el-form-item label="策略"><strong>{{triggerRow?.POLICY_NAME}}</strong></el-form-item>
        <el-form-item label="故障类型"><el-tag type="danger">{{faultTypeLabel(triggerRow?.FAULT_TYPE)}}</el-tag></el-form-item>
        <el-form-item label="执行动作">
          <el-tag :type="triggerRow?.ACTION_TYPE==='HA_FAILOVER'?'danger':triggerRow?.ACTION_TYPE==='AUTO_FIX'?'warning':'info'">
            {{actionTypeLabel(triggerRow?.ACTION_TYPE)}}
          </el-tag>
        </el-form-item>
        <el-form-item label="目标实例">
          <el-select v-model="triggerInstanceId" style="width:100%">
            <el-option v-for="i in instances" :key="i.INSTANCE_ID" :label="i.INSTANCE_NAME" :value="i.INSTANCE_ID"/>
          </el-select>
        </el-form-item>
        <!-- 阈值未达标时展示当前指标 -->
        <template v-if="triggerPreCheck">
          <el-alert type="warning" :closable="false" style="margin-bottom:8px"
            title="当前指标未达触发阈值，以下为实时监控数据" show-icon/>
          <el-form-item v-for="(v,k) in (triggerPreCheck.metrics||{})" :key="k" :label="k" size="small">
            <span>{{v}}</span>
          </el-form-item>
          <el-form-item label="强制执行">
            <el-switch v-model="triggerForce" active-text="强制触发（忽略阈值）"/>
          </el-form-item>
        </template>
      </el-form>
      <template #footer>
        <el-button @click="triggerDlgVisible=false">取消</el-button>
        <el-button :type="triggerForce?'danger':'primary'" :loading="saving" @click="doTriggerFault">
          {{triggerForce?'强制触发':'确认触发'}}
        </el-button>
      </template>
    </el-dialog>

    <!-- ══ 发布工单人工审核 Dialog ══ -->
    <el-dialog v-model="reviewDlgVisible" title="工单人工审核" width="780px" :close-on-click-modal="false">
      <div v-loading="reviewLoading" element-loading-text="加载工单详情...">
        <template v-if="reviewingTicket">
          <!-- 基本信息 -->
          <el-descriptions :column="3" border size="small" style="margin-bottom:12px">
            <el-descriptions-item label="工单号">
              <strong>{{reviewingTicket.TICKET_NO}}</strong>
            </el-descriptions-item>
            <el-descriptions-item label="环境">
              <el-tag :type="reviewingTicket.ENV==='PROD'?'danger':reviewingTicket.ENV==='STAGING'?'warning':'info'" size="small">
                {{reviewingTicket.ENV||'PROD'}}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="提交人">{{reviewingTicket.SUBMITTER}}</el-descriptions-item>
            <el-descriptions-item label="标题" :span="2">{{reviewingTicket.TITLE}}</el-descriptions-item>
            <el-descriptions-item label="实例">{{reviewingTicket.INSTANCE_NAME}}</el-descriptions-item>
          </el-descriptions>

          <!-- 自动审查结果 -->
          <div style="display:flex;gap:16px;margin-bottom:12px;align-items:flex-start">
            <!-- 评分环 -->
            <div class="sql-audit-right" style="min-width:110px">
              <div class="score-ring" :class="scoreClass(reviewingTicket.REVIEW_RESULT_JSON?.score)">
                <span class="score-num">{{reviewingTicket.REVIEW_RESULT_JSON?.score??'-'}}</span>
                <span class="score-label">SQL评分</span>
              </div>
              <el-tag :type="riskColor(reviewingTicket.RISK_LEVEL)" size="small" style="margin-top:4px">
                {{reviewingTicket.RISK_LEVEL}}
              </el-tag>
            </div>
            <!-- 问题列表 -->
            <div style="flex:1;min-width:0">
              <div style="font-size:12px;font-weight:600;color:#606266;margin-bottom:6px">自动审查发现问题：</div>
              <div v-if="!reviewingTicket.REVIEW_RESULT_JSON?.issues?.length" style="color:#67c23a;font-size:13px">✅ 未发现规则问题</div>
              <div v-for="(iss,i) in reviewingTicket.REVIEW_RESULT_JSON?.issues||[]" :key="i" class="audit-issue">
                <el-tag :type="riskColor(iss.severity)" size="small">{{iss.severity}}</el-tag>
                <span>{{iss.message}}</span>
              </div>
              <div v-if="reviewingTicket.REVIEW_RESULT_JSON?.hints?.length" style="margin-top:8px">
                <div style="font-size:12px;font-weight:600;color:#606266;margin-bottom:4px">优化建议：</div>
                <div v-for="(h,i) in reviewingTicket.REVIEW_RESULT_JSON.hints" :key="i"
                  style="font-size:12px;color:#409eff;margin:2px 0">💡 {{h}}</div>
              </div>
            </div>
          </div>

          <!-- SQL 内容 -->
          <div style="font-size:12px;font-weight:600;color:#606266;margin-bottom:4px">SQL 内容：</div>
          <pre class="sql-pre review-sql-pre">{{reviewingTicket.SQL_CONTENT}}</pre>

          <!-- 回滚 SQL -->
          <template v-if="reviewingTicket.ROLLBACK_SQL">
            <div style="font-size:12px;font-weight:600;color:#606266;margin:8px 0 4px">回滚 SQL：</div>
            <pre class="sql-pre" style="max-height:100px;opacity:.8">{{reviewingTicket.ROLLBACK_SQL}}</pre>
          </template>

          <!-- 历史审核流水 -->
          <template v-if="reviewingTicket.REVIEWS?.length">
            <el-divider style="margin:10px 0 8px">历史审核流水</el-divider>
            <el-timeline style="max-height:120px;overflow:auto;padding-left:8px">
              <el-timeline-item v-for="rv in reviewingTicket.REVIEWS" :key="rv.REVIEW_ID"
                :timestamp="fmtTime(rv.CREATED_AT)" placement="top">
                <el-tag size="small" :type="rv.ACTION==='APPROVE'?'success':'danger'">{{rv.ACTION}}</el-tag>
                {{rv.OPERATOR}}<span v-if="rv.COMMENT">：{{rv.COMMENT}}</span>
              </el-timeline-item>
            </el-timeline>
          </template>

          <!-- 审批意见输入 -->
          <el-divider style="margin:10px 0 8px">审批决定</el-divider>
          <el-form label-width="80px" size="small">
            <el-form-item label="审批结果">
              <el-radio-group v-model="reviewAction">
                <el-radio value="APPROVE">
                  <el-tag type="success" size="small">✅ 通过</el-tag>
                  <span style="font-size:12px;color:#606266;margin-left:4px">工单进入可执行状态</span>
                </el-radio>
                <el-radio value="REJECT" style="margin-left:20px">
                  <el-tag type="danger" size="small">❌ 拒绝</el-tag>
                  <span style="font-size:12px;color:#606266;margin-left:4px">退回提交人修改</span>
                </el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="审批意见">
              <el-input v-model="reviewComment" type="textarea" :rows="3"
                :placeholder="reviewAction==='REJECT'?'请说明拒绝原因（必填）':'填写审批意见（选填）...'"
                style="width:100%"/>
            </el-form-item>
            <el-alert v-if="reviewingTicket.RISK_LEVEL==='HIGH' && reviewAction==='APPROVE'"
              type="warning" :closable="false" show-icon
              title="当前 SQL 风险等级为 HIGH，审批通过后请关注执行结果，建议先在非生产环境验证"/>
            <el-alert v-if="reviewingTicket.ENV==='PROD' && reviewAction==='APPROVE'"
              type="error" :closable="false" show-icon style="margin-top:6px"
              title="⚠️ 生产环境工单，审批通过后执行将直接影响线上数据，请仔细核查 SQL 内容"/>
          </el-form>
        </template>
        <el-empty v-else-if="!reviewLoading" description="工单详情加载失败"/>
      </div>
      <template #footer>
        <el-button @click="reviewDlgVisible=false">取消</el-button>
        <el-button
          :type="reviewAction==='APPROVE'?'success':'danger'"
          :loading="saving"
          :disabled="reviewLoading || !reviewingTicket"
          @click="submitReview">
          {{reviewAction==='APPROVE'?'确认通过':'确认拒绝'}}
        </el-button>
      </template>
    </el-dialog>

    <!-- ══ SQL 治理人工审核 Dialog ══ -->
    <el-dialog v-model="auditDetailDlgVisible" title="SQL 治理审查详情 · 人工审核" width="760px" :close-on-click-modal="false">
      <div v-loading="auditDetailLoading" element-loading-text="加载审查详情...">
        <template v-if="auditDetailRow">
          <!-- 基本信息 -->
          <el-descriptions :column="3" border size="small" style="margin-bottom:12px">
            <el-descriptions-item label="实例">{{auditDetailRow.INSTANCE_NAME}}</el-descriptions-item>
            <el-descriptions-item label="来源">
              <el-tag size="small" type="info">{{auditSourceLabel(auditDetailRow.SOURCE)}}</el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="审查时间">{{fmtTime(auditDetailRow.CREATED_AT)}}</el-descriptions-item>
          </el-descriptions>

          <!-- 评分 + 问题列表 -->
          <div style="display:flex;gap:16px;margin-bottom:12px;align-items:flex-start">
            <div class="sql-audit-right" style="min-width:110px">
              <div class="score-ring" :class="scoreClass(auditDetailRow.SCORE)">
                <span class="score-num">{{auditDetailRow.SCORE??'-'}}</span>
                <span class="score-label">SQL评分</span>
              </div>
              <el-tag :type="riskColor(auditDetailRow.RISK_LEVEL)" size="small" style="margin-top:4px">
                {{auditDetailRow.RISK_LEVEL}}
              </el-tag>
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-size:12px;font-weight:600;color:#606266;margin-bottom:6px">审查发现问题：</div>
              <div v-if="!auditDetailRow.AUDIT_RESULT_JSON?.issues?.length" style="color:#67c23a;font-size:13px">✅ 未发现规则问题</div>
              <div v-for="(iss,i) in auditDetailRow.AUDIT_RESULT_JSON?.issues||[]" :key="i" class="audit-issue">
                <el-tag :type="riskColor(iss.severity)" size="small">{{iss.severity}}</el-tag>
                <span>{{iss.message}}</span>
              </div>
              <template v-if="auditDetailRow.AUDIT_RESULT_JSON?.hints?.length">
                <div style="font-size:12px;font-weight:600;color:#606266;margin:8px 0 4px">优化建议：</div>
                <div v-for="(h,i) in auditDetailRow.AUDIT_RESULT_JSON.hints" :key="i"
                  style="font-size:12px;color:#409eff;margin:2px 0">💡 {{h}}</div>
              </template>
            </div>
          </div>

          <!-- SQL 全文 -->
          <div style="font-size:12px;font-weight:600;color:#606266;margin-bottom:4px">SQL 全文：</div>
          <pre class="sql-pre review-sql-pre">{{auditDetailRow.SQL_TEXT}}</pre>

          <!-- 已有人工审核结果时展示 -->
          <el-alert v-if="auditDetailRow.REVIEW_STATUS==='CONFIRMED'" type="success" :closable="false"
            show-icon style="margin-top:10px"
            :title="`已于 ${fmtTime(auditDetailRow.REVIEWED_AT)} 确认有效${auditDetailRow.REVIEW_COMMENT?'：'+auditDetailRow.REVIEW_COMMENT:''}`"/>
          <el-alert v-else-if="auditDetailRow.REVIEW_STATUS==='IGNORED'" type="info" :closable="false"
            show-icon style="margin-top:10px"
            :title="`已于 ${fmtTime(auditDetailRow.REVIEWED_AT)} 标记忽略${auditDetailRow.REVIEW_COMMENT?'：'+auditDetailRow.REVIEW_COMMENT:''}`"/>

          <!-- 待审核时展示意见输入 -->
          <template v-if="auditDetailRow.REVIEW_STATUS==='PENDING'">
            <el-divider style="margin:10px 0 8px">人工审核决定</el-divider>
            <el-alert type="info" :closable="false" show-icon style="margin-bottom:10px"
              title="请仔细阅读SQL内容和问题清单后做出判断：确认有效 = 问题属实需处理；忽略 = 误报或已知可接受风险"/>
            <el-form label-width="80px" size="small">
              <el-form-item label="审核意见">
                <el-input v-model="auditReviewComment" type="textarea" :rows="2"
                  placeholder="填写审核意见或说明（选填）..." style="width:100%"/>
              </el-form-item>
            </el-form>
          </template>
        </template>
        <el-empty v-else-if="!auditDetailLoading" description="详情加载失败"/>
      </div>
      <template #footer>
        <el-button @click="auditDetailDlgVisible=false">关闭</el-button>
        <template v-if="auditDetailRow?.REVIEW_STATUS==='PENDING'">
          <el-button type="info" :loading="saving" @click="submitAuditReview('IGNORE')">
            🚫 标记忽略
          </el-button>
          <el-button type="warning" :loading="saving" @click="submitAuditReview('CONFIRM')">
            ✅ 确认有效
          </el-button>
        </template>
        <el-button
          v-if="auditDetailRow?.REVIEW_STATUS==='CONFIRMED' && ['LOW','MEDIUM'].includes(auditDetailRow?.RISK_LEVEL)"
          type="success" :loading="saving" @click="pushFromAuditDetail">
          🚀 推送发布流程
        </el-button>
      </template>
    </el-dialog>

    <!-- 新建工单 Dialog -->
    <el-dialog v-model="newTicketVisible" title="新建发布工单" width="720px">
      <el-form :model="ticketForm" label-width="100px" size="small">
        <el-row :gutter="12">
          <el-col :span="16"><el-form-item label="标题"><el-input v-model="ticketForm.title"/></el-form-item></el-col>
          <el-col :span="8"><el-form-item label="类型">
            <el-select v-model="ticketForm.ticketType"><el-option label="SQL发布" value="SQL_PUBLISH"/><el-option label="DDL审核" value="DDL_REVIEW"/></el-select>
          </el-form-item></el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12"><el-form-item label="目标实例">
            <el-select v-model="ticketForm.instanceId" clearable style="width:100%">
              <el-option v-for="i in instances" :key="i.INSTANCE_ID" :label="i.INSTANCE_NAME" :value="i.INSTANCE_ID"/>
            </el-select>
          </el-form-item></el-col>
          <el-col :span="12"><el-form-item label="数据库名"><el-input v-model="ticketForm.dbName"/></el-form-item></el-col>
        </el-row>
        <el-form-item label="SQL内容">
          <el-input v-model="ticketForm.sqlContent" type="textarea" :rows="8" placeholder="输入需要发布的SQL..." style="font-family:monospace;font-size:12px"/>
        </el-form-item>
        <el-form-item label="回滚SQL">
          <el-input v-model="ticketForm.rollbackSql" type="textarea" :rows="4" placeholder="回滚用SQL（建议填写）..." style="font-family:monospace;font-size:12px"/>
        </el-form-item>
        <el-form-item label="灰度比例%">
          <el-slider v-model="ticketForm.grayPercent" :marks="{0:'0%',25:'25%',50:'50%',100:'全量'}" style="width:300px"/>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="newTicketVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitTicket">提交工单（自动审查）</el-button>
      </template>
    </el-dialog>

    <!-- 工单详情 Dialog -->
    <el-dialog v-model="ticketDetailVisible" title="工单详情" width="720px">
      <div v-if="currentTicket">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="工单号">{{currentTicket.TICKET_NO}}</el-descriptions-item>
          <el-descriptions-item label="标题">{{currentTicket.TITLE}}</el-descriptions-item>
          <el-descriptions-item label="类型">{{currentTicket.TICKET_TYPE}}</el-descriptions-item>
          <el-descriptions-item label="状态"><el-tag :type="ticketStatusColor(currentTicket.STATUS)" size="small">{{ticketStatusLabel(currentTicket.STATUS)}}</el-tag></el-descriptions-item>
          <el-descriptions-item label="风险等级"><el-tag :type="riskColor(currentTicket.RISK_LEVEL)" size="small">{{currentTicket.RISK_LEVEL}}</el-tag></el-descriptions-item>
          <el-descriptions-item label="提交人">{{currentTicket.SUBMITTER}}</el-descriptions-item>
        </el-descriptions>
        <el-divider>SQL内容</el-divider>
        <pre class="sql-pre">{{currentTicket.SQL_CONTENT}}</pre>
        <el-divider v-if="currentTicket.ROLLBACK_SQL">回滚SQL</el-divider>
        <pre v-if="currentTicket.ROLLBACK_SQL" class="sql-pre">{{currentTicket.ROLLBACK_SQL}}</pre>
        <el-divider>自动审核结果</el-divider>
        <div v-if="currentTicket.REVIEW_RESULT_JSON">
          <div>评分: <strong :class="scoreClass(currentTicket.REVIEW_RESULT_JSON.score)">{{currentTicket.REVIEW_RESULT_JSON.score}}</strong></div>
          <div v-for="(iss,i) in currentTicket.REVIEW_RESULT_JSON.issues||[]" :key="i" class="audit-issue">
            <el-tag :type="riskColor(iss.severity)" size="small">{{iss.severity}}</el-tag> {{iss.message}}
          </div>
        </div>
        <el-divider v-if="currentTicket.REVIEWS?.length">审核流水</el-divider>
        <el-timeline>
          <el-timeline-item v-for="rv in currentTicket.REVIEWS||[]" :key="rv.REVIEW_ID" :timestamp="fmtTime(rv.CREATED_AT)">
            <el-tag size="small">{{rv.ACTION}}</el-tag> {{rv.OPERATOR}}: {{rv.COMMENT||''}}
          </el-timeline-item>
        </el-timeline>
      </div>
    </el-dialog>

    <!-- 执行工单 Dialog -->
    <el-dialog v-model="execDlgVisible" title="执行工单" width="400px">
      <el-form label-width="100px" size="small">
        <el-form-item label="工单">{{execRow?.TICKET_NO}}</el-form-item>
        <el-form-item label="灰度比例%">
          <el-slider v-model="execGrayPct" :marks="{0:'0%',25:'25%',50:'50%',100:'全量'}" style="width:200px"/>
          <span style="margin-left:8px">{{execGrayPct}}%</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="execDlgVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="doExecuteTicket">确认执行</el-button>
      </template>
    </el-dialog>

    <!-- SQL基线 Dialog -->
    <el-dialog v-model="baselineDlgVisible" title="固化SQL基线" width="560px">
      <el-form :model="baselineForm" label-width="100px" size="small">
        <el-form-item label="SQL Hash"><el-input v-model="baselineForm.sqlHash"/></el-form-item>
        <el-form-item label="SQL文本"><el-input v-model="baselineForm.sqlText" type="textarea" :rows="4"/></el-form-item>
        <el-form-item label="绑定实例">
          <el-select v-model="baselineForm.instanceId" clearable style="width:100%">
            <el-option v-for="i in instances" :key="i.INSTANCE_ID" :label="i.INSTANCE_NAME" :value="i.INSTANCE_ID"/>
          </el-select>
        </el-form-item>
        <el-form-item label="基线类型">
          <el-select v-model="baselineForm.baselineType">
            <el-option label="FIXED（固化）" value="FIXED"/><el-option label="APPROVED（审批）" value="APPROVED"/>
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="baselineDlgVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveBaseline">固化</el-button>
      </template>
    </el-dialog>

    <!-- HA拓扑 Dialog -->
    <el-dialog v-model="topoDlgVisible" :title="topoForm.topoId?'编辑HA拓扑':'新建HA拓扑'" width="560px">
      <el-form :model="topoForm" label-width="100px" size="small">
        <el-form-item label="拓扑名称"><el-input v-model="topoForm.topoName"/></el-form-item>
        <el-form-item label="HA类型">
          <el-select v-model="topoForm.haType">
            <el-option v-for="h in haTypes" :key="h" :label="h" :value="h"/>
          </el-select>
        </el-form-item>
        <el-form-item label="主节点实例">
          <el-select v-model="topoForm.primaryId" clearable style="width:100%">
            <el-option v-for="i in instances" :key="i.INSTANCE_ID" :label="i.INSTANCE_NAME" :value="i.INSTANCE_ID"/>
          </el-select>
        </el-form-item>
        <el-form-item label="VIP"><el-input v-model="topoForm.vip" placeholder="192.168.1.100:3306"/></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="topoDlgVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveTopology">保存</el-button>
      </template>
    </el-dialog>

    <!-- 一键切换 Dialog -->
    <el-dialog v-model="switchDlgVisible" title="一键切换" width="480px">
      <el-form :model="switchForm" label-width="100px" size="small">
        <el-form-item label="拓扑"><strong>{{switchRow?.TOPO_NAME}}</strong> ({{switchRow?.HA_TYPE}})</el-form-item>
        <el-form-item label="当前主节点"><el-tag>ID: {{switchRow?.PRIMARY_ID}}</el-tag></el-form-item>
        <el-form-item label="切换类型">
          <el-radio-group v-model="switchForm.switchType">
            <el-radio value="PLANNED">计划切换</el-radio>
            <el-radio value="FAILOVER">故障切换</el-radio>
            <el-radio value="DRILL">演练</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="切换至节点">
          <el-select v-model="switchForm.toNode" style="width:100%">
            <el-option v-for="i in instances" :key="i.INSTANCE_ID" :label="i.INSTANCE_NAME" :value="i.INSTANCE_ID"/>
          </el-select>
        </el-form-item>
        <el-alert type="warning" :closable="false" title="切换前请确认: 复制延迟<10s、磁盘空间充足、应用连接池已配置自动重连" show-icon/>
      </el-form>
      <template #footer>
        <el-button @click="switchDlgVisible=false">取消</el-button>
        <el-button type="danger" :loading="saving" @click="doHaSwitch">确认切换</el-button>
      </template>
    </el-dialog>

    <!-- 容灾链路 Dialog -->
    <el-dialog v-model="drLinkDlgVisible" title="添加容灾链路" width="480px">
      <el-form :model="drLinkForm" label-width="100px" size="small">
        <el-form-item label="链路名称"><el-input v-model="drLinkForm.linkName"/></el-form-item>
        <el-form-item label="源地域"><el-input v-model="drLinkForm.sourceRegion" placeholder="北京"/></el-form-item>
        <el-form-item label="目标地域"><el-input v-model="drLinkForm.targetRegion" placeholder="上海"/></el-form-item>
        <el-form-item label="主实例">
          <el-select v-model="drLinkForm.sourceId" clearable style="width:100%">
            <el-option v-for="i in instances" :key="i.INSTANCE_ID" :label="i.INSTANCE_NAME" :value="i.INSTANCE_ID"/>
          </el-select>
        </el-form-item>
        <el-form-item label="备实例">
          <el-select v-model="drLinkForm.targetId" clearable style="width:100%">
            <el-option v-for="i in instances" :key="i.INSTANCE_ID" :label="i.INSTANCE_NAME" :value="i.INSTANCE_ID"/>
          </el-select>
        </el-form-item>
        <el-form-item label="同步模式">
          <el-select v-model="drLinkForm.syncMode">
            <el-option label="异步(ASYNC)" value="ASYNC"/><el-option label="半同步(SEMI)" value="SEMI_SYNC"/><el-option label="同步(SYNC)" value="SYNC"/>
          </el-select>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12"><el-form-item label="RPO(s)"><el-input-number v-model="drLinkForm.rpoSec" :min="0" style="width:100%"/></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="RTO(s)"><el-input-number v-model="drLinkForm.rtoSec" :min="0" style="width:100%"/></el-form-item></el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="drLinkDlgVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveDrLink">保存</el-button>
      </template>
    </el-dialog>

    <!-- 备份策略 Dialog -->
    <el-dialog v-model="bkPolicyDlgVisible" :title="bkPolicyForm.policyId?'编辑备份策略':'新建备份策略'" width="560px">
      <el-form :model="bkPolicyForm" label-width="100px" size="small">
        <el-form-item label="策略名称"><el-input v-model="bkPolicyForm.policyName"/></el-form-item>
        <el-form-item label="目标实例">
          <el-select v-model="bkPolicyForm.instanceId" clearable style="width:100%">
            <el-option v-for="i in instances" :key="i.INSTANCE_ID" :label="i.INSTANCE_NAME" :value="i.INSTANCE_ID"/>
          </el-select>
        </el-form-item>
        <el-form-item label="备份类型">
          <el-select v-model="bkPolicyForm.backupType">
            <el-option label="全量备份(FULL)" value="FULL"/><el-option label="增量备份(INCREMENTAL)" value="INCREMENTAL"/>
            <el-option label="逻辑备份(LOGICAL)" value="LOGICAL"/><el-option label="物理备份(PHYSICAL)" value="PHYSICAL"/>
          </el-select>
        </el-form-item>
        <el-form-item label="存储类型">
          <el-select v-model="bkPolicyForm.storageType">
            <el-option label="本地(LOCAL)" value="LOCAL"/><el-option label="NFS" value="NFS"/>
            <el-option label="S3" value="S3"/><el-option label="OSS" value="OSS"/>
          </el-select>
        </el-form-item>
        <el-form-item label="存储路径"><el-input v-model="bkPolicyForm.storagePath" placeholder="/backup/mysql"/></el-form-item>
        <el-form-item label="保留天数"><el-input-number v-model="bkPolicyForm.retentionDays" :min="1" :max="365"/></el-form-item>
        <el-form-item label="调度计划"><el-input v-model="bkPolicyForm.schedule" placeholder="0 2 * * *"/></el-form-item>
        <el-form-item label="压缩"><el-switch v-model="bkPolicyForm.compress"/></el-form-item>
        <el-form-item label="加密"><el-switch v-model="bkPolicyForm.encrypt"/></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="bkPolicyDlgVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveBkPolicy">保存</el-button>
      </template>
    </el-dialog>

    <!-- 恢复任务 Dialog -->
    <el-dialog v-model="restoreDlgVisible" title="新建恢复任务" width="520px">
      <el-form :model="restoreForm" label-width="100px" size="small">
        <el-form-item label="目标实例">
          <el-select v-model="restoreForm.instanceId" style="width:100%">
            <el-option v-for="i in instances" :key="i.INSTANCE_ID" :label="i.INSTANCE_NAME" :value="i.INSTANCE_ID"/>
          </el-select>
        </el-form-item>
        <el-form-item label="恢复类型">
          <el-select v-model="restoreForm.restoreType">
            <el-option label="PITR（时间点恢复）" value="PITR"/>
            <el-option label="单表恢复" value="SINGLE_TABLE"/>
            <el-option label="闪回恢复" value="FLASHBACK"/>
            <el-option label="全量恢复" value="FULL"/>
          </el-select>
        </el-form-item>
        <el-form-item v-if="restoreForm.restoreType==='PITR'" label="目标时间">
          <el-date-picker v-model="restoreForm.targetTime" type="datetime" format="YYYY-MM-DD HH:mm:ss" value-format="YYYY-MM-DD HH:mm:ss" style="width:100%"/>
        </el-form-item>
        <el-form-item v-if="restoreForm.restoreType==='SINGLE_TABLE'" label="目标表名">
          <el-input v-model="restoreForm.targetTable" placeholder="schema.table_name"/>
        </el-form-item>
        <el-form-item v-if="restoreForm.restoreType==='FLASHBACK'" label="闪回SCN">
          <el-input v-model="restoreForm.flashbackScn" placeholder="Oracle SCN号"/>
        </el-form-item>
        <el-alert type="warning" :closable="false" title="恢复操作不可逆，请确认已评估影响范围并通知相关业务方" show-icon/>
      </el-form>
      <template #footer>
        <el-button @click="restoreDlgVisible=false">取消</el-button>
        <el-button type="danger" :loading="saving" @click="createRestore">创建并执行</el-button>
      </template>
    </el-dialog>

    <!-- 报告详情 Dialog -->
    <el-dialog v-model="reportDetailVisible" title="巡检报告详情" width="700px">
      <div v-if="reportDetail">
        <el-descriptions :column="3" border size="small" style="margin-bottom:12px">
          <el-descriptions-item label="实例">{{reportDetail.INSTANCE_NAME}}</el-descriptions-item>
          <el-descriptions-item label="数据库">{{reportDetail.DB_TYPE}}</el-descriptions-item>
          <el-descriptions-item label="报告类型">{{reportDetail.REPORT_TYPE}}</el-descriptions-item>
          <el-descriptions-item label="综合评分"><span :class="scoreClass(reportDetail.OVERALL_SCORE)">{{reportDetail.OVERALL_SCORE}}</span></el-descriptions-item>
          <el-descriptions-item label="状态"><el-tag :type="statusColor(reportDetail.OVERALL_STATUS)" size="small">{{reportDetail.OVERALL_STATUS}}</el-tag></el-descriptions-item>
          <el-descriptions-item label="巡检时间">{{fmtTime(reportDetail.CREATED_AT)}}</el-descriptions-item>
        </el-descriptions>
        <div v-if="reportDetail.PAYLOAD_JSON?.items?.length">
          <el-table :data="reportDetail.PAYLOAD_JSON.items" size="small" stripe>
            <el-table-column v-for="col in reportDetailCols(reportDetail.REPORT_TYPE)" :key="col.prop" :prop="col.prop" :label="col.label" :width="col.width" :min-width="col.minWidth" show-overflow-tooltip/>
          </el-table>
        </div>
        <div v-else-if="(reportDetail.PAYLOAD_JSON?.scriptSections||[]).length" class="report-script-sections">
          <el-collapse accordion>
            <el-collapse-item v-for="(sec,si) in reportDetail.PAYLOAD_JSON.scriptSections" :key="si" :title="sec.title || ('分段 ' + (si+1))">
              <div v-for="(tb,ti) in (sec.tables||[])" :key="ti">
                <el-table v-if="(tb.columns||[]).length" :data="tb.rows||[]" size="small" stripe style="margin-bottom:12px">
                  <el-table-column v-for="c in tb.columns" :key="c" :prop="c" :label="c" min-width="100" show-overflow-tooltip/>
                </el-table>
              </div>
            </el-collapse-item>
          </el-collapse>
        </div>
      </div>
    </el-dialog>

    <!-- DDL规则 Dialog -->
    <el-dialog v-model="ddlRuleDlgVisible" title="新建DDL审核规则" width="480px">
      <el-form :model="ddlRuleForm" label-width="90px" size="small">
        <el-form-item label="规则编码"><el-input v-model="ddlRuleForm.ruleCode" placeholder="NO_SELECT_STAR"/></el-form-item>
        <el-form-item label="规则名称"><el-input v-model="ddlRuleForm.ruleName"/></el-form-item>
        <el-form-item label="适用DB"><el-select v-model="ddlRuleForm.dbType"><el-option label="ALL(全部)" value="ALL"/><el-option v-for="t in dbTypes" :key="t" :label="t" :value="t"/></el-select></el-form-item>
        <el-form-item label="级别"><el-select v-model="ddlRuleForm.severity"><el-option label="CRITICAL" value="CRITICAL"/><el-option label="ERROR" value="ERROR"/><el-option label="WARNING" value="WARNING"/></el-select></el-form-item>
        <el-form-item label="提示信息"><el-input v-model="ddlRuleForm.message" type="textarea" :rows="2"/></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="ddlRuleDlgVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveDdlRule">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAuthStore } from '@/stores/auth.js'
import { automationApi, cmdbApi } from '@/api/index.js'
import {
  Search, Warning, Promotion, DataAnalysis, Connection, TrendCharts, FolderOpened,
  Refresh, ArrowDown, WarningFilled, LocationFilled
} from '@element-plus/icons-vue'

const auth = useAuthStore()
const canMutate = computed(() => ['ADMIN','DBA','OPS'].includes(auth.user?.role))

// ── Constants ──────────────────────────────────────────────
const dbTypes = ['ORACLE','MYSQL','POSTGRESQL','DAMENG','GOLDENDB']
const haTypes  = ['MGR','PXC','ADG','RAC','REPLICATION','SENTINEL']
const reportCategories = [
  {v:'HEALTH',l:'健康报告'},{v:'RISK',l:'风险报告'},
  {v:'PARAMETER',l:'参数异常'},{v:'SPACE',l:'空间风险'},{v:'HA',l:'HA风险'}
]
/** 脚本库新建/上传时固定入库的分类（界面已隐藏报告类型） */
const inspectScriptDefaultCategory = 'HEALTH'
const ticketStatuses = [
  {v:'DRAFT',l:'草稿'},{v:'REVIEWING',l:'审核中'},{v:'APPROVED',l:'已通过'},
  {v:'REJECTED',l:'已拒绝'},{v:'EXECUTING',l:'执行中'},{v:'GRAY_TESTING',l:'灰度测试'},
  {v:'DONE',l:'已完成'},{v:'ROLLED_BACK',l:'已回滚'}
]
const faultTypeMap = {
  REPL_DELAY:'主从延迟',REPL_BROKEN:'复制中断',DISK_FULL:'磁盘空间满',
  TEMP_FULL:'TEMP表空间满',FRA_FULL:'FRA空间满',SESSION_ABNORMAL:'会话异常',
  SLOW_QUERY:'慢查询告警',CONN_SURGE:'连接数突增',
}
const actionTypeMap = {
  AUTO_FIX:'自动修复',HA_FAILOVER:'HA故障转移',ALERT_ONLY:'仅告警',MANUAL:'人工处理',NOTIFY:'通知',
}
const actionTypeLabel = t => actionTypeMap[t]||t
const faultTypesFor = db => {
  const m = {
    MYSQL:   ['REPL_DELAY','REPL_BROKEN','DISK_FULL','SLOW_QUERY','CONN_SURGE'].map(v=>({v,l:faultTypeMap[v]})),
    ORACLE:  ['TEMP_FULL','FRA_FULL','SESSION_ABNORMAL','SLOW_QUERY'].map(v=>({v,l:faultTypeMap[v]})),
    POSTGRESQL:[{v:'REPL_DELAY',l:faultTypeMap['REPL_DELAY']},{v:'DISK_FULL',l:faultTypeMap['DISK_FULL']},{v:'SLOW_QUERY',l:faultTypeMap['SLOW_QUERY']}],
    DAMENG:  ['TEMP_FULL','FRA_FULL','SESSION_ABNORMAL','SLOW_QUERY'].map(v=>({v,l:faultTypeMap[v]})),
    GOLDENDB:['REPL_DELAY','REPL_BROKEN','DISK_FULL','SLOW_QUERY','CONN_SURGE'].map(v=>({v,l:faultTypeMap[v]})),
    ALL:     Object.entries(faultTypeMap).map(([v,l])=>({v,l})),
  }
  return m[db]||Object.entries(faultTypeMap).map(([v,l])=>({v,l}))
}
const auditSourceLabel = s => ({MANUAL:'手动审核',FAULT_AUTO:'故障自动',SLOW_IMPORT:'慢查询导入',PUBLISH_PRE:'发布预审'})[s]||s

// ── State ──────────────────────────────────────────────────
const activeModule = ref('inspect')
const saving = ref(false)
const instances = ref([])

// Inspect
const inspectTab = ref('scripts')
const scripts = ref([])
const scriptsLoading = ref(false)
/** 巡检脚本下载清单（后端按报告类型分项，对齐 RISK_INSPECT_README） */
const inspectDownloadTemplates = ref([])
const scriptFilter = reactive({ dbType: '' })
const inspectTasks = ref([])
const reportMap = reactive({})
const reportFilter = reactive({instanceId:null})
const runningTask = ref(null)
const scriptDlgVisible = ref(false)
const scriptForm = reactive({scriptId:null,scriptName:'',dbType:'MYSQL',category:inspectScriptDefaultCategory,scriptContent:'',version:'1.0',enabled:true})
const uploadScriptVisible = ref(false)
const uploadForm = reactive({dbType:'MYSQL'})
const uploadNativeInputRef = ref()
/** 本地选中的巡检脚本（File，与原生 input 绑定，不依赖 el-upload） */
const uploadScriptRawFile = ref(null)
watch(uploadScriptVisible, v => {
  if (v) {
    uploadScriptRawFile.value = null
    nextTick(() => {
      const inp = uploadNativeInputRef.value
      if (inp) inp.value = ''
    })
  }
})
const taskDlgVisible = ref(false)
/** 立即巡检返回的详情（fetch 直调，避免 axios 非 200 丢弃 data） */
const taskRunDetailVisible = ref(false)
const taskRunDetail = ref({ code: 200, msg: '', logs: [], sqlErrors: [], reportIds: [], reports: 0, instances: 0 })
const taskScriptsCache = ref([])
const taskForm = reactive({ taskName: '', dbType: '', instanceIds: [], scriptIds: [], cronExpr: '' })
const scriptsForTaskPicker = computed(() => {
  const list = taskScriptsCache.value || []
  if (!taskForm.dbType) return list
  return list.filter((s) => s.DB_TYPE === taskForm.dbType)
})
const reportDetailVisible = ref(false)
const reportDetail = ref(null)

// Fault
const faultTab = ref('policies')
const faultPolicies = ref([])
const faultPoliciesLoading = ref(false)
const faultFilter = reactive({dbType:''})
const faultLogs = ref([])
const faultLogsLoading = ref(false)
const faultLogFilter = reactive({status:'', faultType:''})
const faultDashboard = ref(null)
const faultDlgVisible = ref(false)
const faultForm = reactive({policyId:null,policyName:'',dbType:'MYSQL',faultType:'',actionType:'AUTO_FIX',actionScript:'',enabled:true,conditionJson:null})
const triggerDlgVisible = ref(false)
const triggerRow = ref(null)
const triggerInstanceId = ref(null)
const triggerForce = ref(false)
const triggerPreCheck = ref(null)

// Publish
const publishTab = ref('tickets')
const tickets = ref([])
const ticketFilter = reactive({status:'',ticketType:'',env:''})
const ddlRules = ref([])
const newTicketVisible = ref(false)
const ticketForm = reactive({title:'',ticketType:'SQL_PUBLISH',instanceId:null,dbName:'',sqlContent:'',rollbackSql:'',grayPercent:100})
const ticketDetailVisible = ref(false)
const currentTicket = ref(null)
const execDlgVisible = ref(false)
const execRow = ref(null)
const execGrayPct = ref(100)
const ddlRuleDlgVisible = ref(false)
const ddlRuleForm = reactive({ruleCode:'',ruleName:'',dbType:'ALL',severity:'WARNING',message:''})

// SQL
const sqlTab = ref('audit')
const auditSql = ref('')
const auditInstanceId = ref(null)
const auditLoading = ref(false)
const auditResult = ref(null)
const auditHistory = ref([])
const auditHistFilter = reactive({riskLevel:'', source:''})
const scoreConfig = ref([])
const baselines = ref([])
const regressions = ref([])
const regressionLoading = ref(false)
const baselineDlgVisible = ref(false)
const baselineForm = reactive({sqlHash:'',sqlText:'',instanceId:null,baselineType:'FIXED'})
const sqlHealthOverview = ref([])
const slowQueryInstanceId = ref(null)
const importingSlowQuery = ref(false)
const lastAuditId = ref(null)

// HA
const haTab = ref('topologies')
const topologies = ref([])
const switches = ref([])
const drLinks = ref([])
const haDashboard = ref(null)
const healthCheckResult = ref(null)
const switchHistFilter = reactive({switchType:''})
const drillingLink = ref(null)

// ── 自动发布 人工审核弹窗 ────────────────────────────────
const reviewDlgVisible   = ref(false)
const reviewingTicket    = ref(null)      // 完整工单详情
const reviewingRow       = ref(null)      // 列表行（含 TICKET_ID）
const reviewComment      = ref('')
const reviewAction       = ref('APPROVE') // APPROVE | REJECT
const reviewLoading      = ref(false)

// ── SQL 治理 人工审核弹窗 ────────────────────────────────
const auditDetailDlgVisible = ref(false)
const auditDetailRow        = ref(null)   // 完整审核记录
const auditDetailLoading    = ref(false)
const auditReviewComment    = ref('')
const auditReviewFilter     = reactive({ reviewStatus: '' })
const topoDlgVisible = ref(false)
const topoForm = reactive({topoId:null,topoName:'',haType:'MGR',primaryId:null,vip:''})
const switchDlgVisible = ref(false)
const switchRow = ref(null)
const switchForm = reactive({switchType:'PLANNED',toNode:null})
const drLinkDlgVisible = ref(false)
const drLinkForm = reactive({linkName:'',sourceRegion:'北京',targetRegion:'上海',sourceId:null,targetId:null,syncMode:'ASYNC',rpoSec:30,rtoSec:120})

// Capacity
const capacityTab = ref('snapshots')
const capacityInstanceId = ref(null)
const snapshots = ref([])
const forecasts = ref([])
const costAnalysis = ref([])
const collectingSnap = ref(false)
const forecastLoading = ref(false)
const costAnalysisLoading = ref(false)

// Backup
const backupTab = ref('policies')
const bkPolicies = ref([])
const bkRecords = ref([])
const bkStats = ref(null)
const restores = ref([])
const bkFilter = reactive({backupType:'',status:''})
const runningBk = ref(null)
const bkPolicyDlgVisible = ref(false)
const bkPolicyForm = reactive({policyId:null,policyName:'',instanceId:null,backupType:'FULL',storageType:'LOCAL',storagePath:'/backup',retentionDays:7,schedule:'0 2 * * *',compress:true,encrypt:false})
const restoreDlgVisible = ref(false)
const restoreForm = reactive({instanceId:null,restoreType:'PITR',targetTime:'',targetTable:'',flashbackScn:''})

// ── Helpers ────────────────────────────────────────────────
const fmtTime = t => t ? String(t).replace('T',' ').substring(0,19) : '-'
const scoreClass = s => Number(s)>=90?'text-success':Number(s)>=70?'text-warning':'text-danger'
const statusColor = s => s==='NORMAL'?'success':s==='WARNING'?'warning':'danger'
const reportCategoryLabel = c => reportCategories.find(x=>x.v===c)?.l||c
const taskStatusColor = s => ({IDLE:'info',RUNNING:'warning',DONE:'success',FAILED:'danger'})[s]||''
const riskColor   = r => ({LOW:'success',MEDIUM:'warning',HIGH:'danger',CRITICAL:'danger',WARNING:'warning',ERROR:'danger'})[r]||''
const ticketStatusColor = s => ({DRAFT:'info',REVIEWING:'warning',APPROVED:'success',REJECTED:'danger',GRAY:'warning',DONE:'success',ROLLED_BACK:'info'})[s]||''
const ticketStatusLabel = s => ticketStatuses.find(x=>x.v===s)?.l||s
const faultTypeLabel = f => faultTypeMap[f]||f
const topoStatusColor = s => ({NORMAL:'success',WARNING:'warning',FAILOVER:'danger',MAINTENANCE:'info'})[s]||''
const switchTypeLabel = s => ({PLANNED:'计划切换',FAILOVER:'故障切换',DRILL:'演练'})[s]||s
const switchTypeColor = s => ({PLANNED:'success',FAILOVER:'danger',DRILL:'warning'})[s]||''
const bkTypeLabel = t => ({FULL:'全量备份',INCREMENTAL:'增量备份',LOGICAL:'逻辑备份',PHYSICAL:'物理备份'})[t]||t
const bkTypeColor = t => ({FULL:'success',INCREMENTAL:'',LOGICAL:'warning',PHYSICAL:'info'})[t]||''
const bkStatusColor = s => ({SUCCESS:'success',FAILED:'danger',RUNNING:'warning',PENDING:'info'})[s]||''
const restoreTypeLabel = t => ({PITR:'PITR时间点',SINGLE_TABLE:'单表恢复',FLASHBACK:'闪回恢复',FULL:'全量恢复'})[t]||t
const reportDetailCols = type => {
  const maps = {
    HEALTH:[{prop:'name',label:'检查项',width:130},{prop:'value',label:'当前值',minWidth:120},{prop:'status',label:'状态',width:80}],
    RISK:[{prop:'category',label:'类别',width:70},{prop:'level',label:'级别',width:80},{prop:'title',label:'问题',width:150},{prop:'detail',label:'详情',minWidth:200}],
    PARAMETER:[{prop:'param',label:'参数名',width:200},{prop:'current',label:'当前值',width:90},{prop:'recommended',label:'建议值',width:90},{prop:'status',label:'状态',width:80}],
    SPACE:[{prop:'tablespace',label:'表空间',width:120},{prop:'usedGB',label:'已用GB',width:80},{prop:'totalGB',label:'总GB',width:70},{prop:'pct',label:'使用%',width:70},{prop:'status',label:'状态',width:80}],
    HA:[{prop:'item',label:'检查项',width:130},{prop:'value',label:'当前值',minWidth:150},{prop:'threshold',label:'阈值',width:80},{prop:'status',label:'状态',width:80}],
  }
  return maps[type]||[]
}
const inspectReportStatusLabel = s => ({ NORMAL:'正常', WARNING:'预警', CRITICAL:'严重' })[String(s||'').toUpperCase()] || s || ''
/** 巡检报告摘要：优先展示「巡检完成，评分」；兼容历史 Word 文案 */
function reportSummaryText(row) {
  const score = row?.OVERALL_SCORE
  if (score != null && score !== '') {
    const st = inspectReportStatusLabel(row.OVERALL_STATUS)
    return `巡检完成，评分 ${score}${st ? `，${st}` : ''}`
  }
  const raw = String(row?.SUMMARY || '')
  if (/Word巡检报告|db_inspection\.py/.test(raw)) return '巡检完成，评分 -'
  return raw || '巡检完成，评分 -'
}

// ── Switch module & load ───────────────────────────────────
function switchModule(key) {
  activeModule.value = key
  if (key==='inspect') { loadScripts(); loadTasks(); loadInspectTemplates(); loadAllInspectReports() }
  if (key==='fault') { loadFaultPolicies(); loadFaultLogs(); loadFaultDashboard() }
  if (key==='publish') { loadTickets(); loadDdlRules() }
  if (key==='sql') { loadAuditHistory(); loadScoreConfig(); loadBaselines(); loadRegressions(); loadSqlHealthOverview() }
  if (key==='ha') { loadTopologies(); loadSwitches(); loadDrLinks(); loadHaDashboard() }
  if (key==='capacity') { loadSnapshots(); loadCostAnalysis() }
  if (key==='backup') { loadBackupPolicies(); loadBkRecords(); loadBkStats(); loadRestores() }
}

async function loadInspectTemplates() {
  try {
    const r = await automationApi.inspectScriptTemplates()
    const list = Array.isArray(r?.data) ? r.data : []
    inspectDownloadTemplates.value = list.filter((x) => x && x.fileName)
    if (r?.msg && !inspectDownloadTemplates.value.length) {
      ElMessage.warning(String(r.msg))
    }
  } catch {
    inspectDownloadTemplates.value = []
  }
}

// ── INSPECT ───────────────────────────────────────────────
async function loadScripts() {
  const p = {}
  if (scriptFilter.dbType) p.dbType = scriptFilter.dbType
  scriptsLoading.value = true
  try {
    const r = await automationApi.inspectScripts(p)
    const list = Array.isArray(r?.data) ? r.data : []
    scripts.value = [...list]
    return true
  } catch (e) {
    scripts.value = []
    ElMessage.error(e?.message || '加载巡检脚本失败')
    return false
  } finally {
    scriptsLoading.value = false
  }
}
/** 脚本库工具栏「刷新」：重新拉取列表，成功时提示 */
async function refreshScriptLibrary() {
  const ok = await loadScripts()
  if (ok) ElMessage.success('巡检脚本列表已刷新')
}
async function loadTasks() {
  const r = await automationApi.inspectTasks().catch(()=>({data:[]}))
  inspectTasks.value = r.data||[]
}
async function deleteInspectTask(id) {
  await ElMessageBox.confirm('确认删除该巡检任务？若有 Cron，定时将不再执行。已生成的巡检报告仍可在「巡检报告」中查看。', '提示', { type: 'warning' }).catch(() => { throw '' })
  await automationApi.deleteInspectTask(id)
  ElMessage.success('已删除')
  loadTasks()
}
async function loadReports(cat) {
  const p = { reportType: cat, page: 1, pageSize: 20 }
  if (reportFilter.instanceId) p.instanceId = reportFilter.instanceId
  const r = await automationApi.inspectReports(p).catch(()=>({ data: [] }))
  reportMap[cat] = r.data || []
}
function loadAllInspectReports() {
  for (const cat of reportCategories) loadReports(cat.v)
}
watch(inspectTab, (tab) => {
  if (activeModule.value !== 'inspect') return
  if (String(tab).startsWith('rpt_')) loadReports(tab.slice(4))
})
async function runTask(id) {
  runningTask.value = id
  try {
    const token = localStorage.getItem('token')
    const res = await fetch(`/api/automation/inspect/tasks/${id}/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: '{}',
    })
    let j = {}
    try {
      j = await res.json()
    } catch {
      j = { code: res.ok ? 200 : 500, msg: '响应解析失败', data: {} }
    }
    const data = j.data || {}
    const logs = Array.isArray(data.logs) ? data.logs : []
    const sqlErrors = Array.isArray(data.sqlErrors) ? data.sqlErrors : []
    const reportIds = Array.isArray(data.reportIds) ? data.reportIds : []
    taskRunDetail.value = {
      code: j.code,
      msg: j.msg || '',
      logs,
      sqlErrors,
      reportIds,
      reports: data.reports ?? 0,
      instances: data.instances ?? 0,
    }
    taskRunDetailVisible.value = true
    if (Number(j.code) === 200) {
      ElMessage.success(j.msg || '巡检完成')
      loadAllInspectReports()
    } else {
      ElMessage.error(j.msg || '巡检失败')
    }
    loadTasks()
  } catch (e) {
    taskRunDetail.value = {
      code: 500,
      msg: e?.message || '请求失败',
      logs: [],
      sqlErrors: [],
      reportIds: [],
      reports: 0,
      instances: 0,
    }
    taskRunDetailVisible.value = true
    ElMessage.error(e?.message || '请求失败')
  } finally {
    runningTask.value = null
  }
}
async function openScriptDlg(row) {
  if (row) {
    let scriptContent = ''
    let detailErr = ''
    try {
      const r = await automationApi.inspectScript(row.SCRIPT_ID)
      const d = r?.data
      if (d && d.SCRIPT_CONTENT != null) scriptContent = String(d.SCRIPT_CONTENT)
    } catch (e) {
      detailErr = e?.message || '请求失败'
    }
    Object.assign(scriptForm, {
      scriptId: row.SCRIPT_ID,
      scriptName: row.SCRIPT_NAME,
      dbType: row.DB_TYPE,
      category: row.CATEGORY,
      scriptContent,
      version: row.VERSION != null ? String(row.VERSION) : '1.0',
      enabled: !!row.ENABLED,
    })
    scriptDlgVisible.value = true
    if (detailErr) ElMessage.warning(`脚本详情加载失败（${detailErr}），可手动填写后保存`)
  } else {
    Object.assign(scriptForm, { scriptId:null, scriptName:'', dbType:'MYSQL', category:inspectScriptDefaultCategory, scriptContent:'', version:'1.0', enabled:true })
    scriptDlgVisible.value=true
  }
}
async function saveScript() {
  if(!scriptForm.scriptName||!scriptForm.dbType) return ElMessage.warning('名称和DB类型必填')
  saving.value=true
  try {
    if (scriptForm.scriptId) {
      await automationApi.updateInspectScript(scriptForm.scriptId, {
        scriptName: scriptForm.scriptName,
        scriptContent: scriptForm.scriptContent ?? '',
        version: scriptForm.version,
        enabled: scriptForm.enabled,
      })
    } else {
      await automationApi.createInspectScript(scriptForm)
    }
    ElMessage.success('保存成功'); scriptDlgVisible.value=false; loadScripts()
  } catch (e) {
    ElMessage.error(e?.message || '保存失败')
  } finally { saving.value=false }
}
async function deleteScript(id) {
  await ElMessageBox.confirm('确认删除该脚本？','提示',{type:'warning'}).catch(()=>{throw ''})
  await automationApi.deleteInspectScript(id); ElMessage.success('已删除'); loadScripts()
}
function onScriptFileInputChange(e) {
  const f = e?.target?.files?.[0]
  uploadScriptRawFile.value = f || null
}
function pickScriptFile() {
  uploadNativeInputRef.value?.click()
}
function clearPickedScriptFile() {
  uploadScriptRawFile.value = null
  const inp = uploadNativeInputRef.value
  if (inp) inp.value = ''
}
async function doUploadScript() {
  const rawFile = uploadScriptRawFile.value
  if(!rawFile) return ElMessage.warning('请选择文件')
  saving.value=true
  const fd = new FormData()
  fd.append('file', rawFile)
  fd.append('dbType', uploadForm.dbType)
  fd.append('category', inspectScriptDefaultCategory)
  const token = localStorage.getItem('token')
  try {
    const res = await fetch('/api/automation/inspect/scripts/upload', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    })
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      ElMessage.error('服务器返回非 JSON，请检查网络或代理')
      return
    }
    if (Number(data?.code) === 401) {
      localStorage.clear()
      window.location.href = '/login'
      return
    }
    if (!res.ok || Number(data?.code) !== 200) {
      ElMessage.error(data?.msg || res.statusText || '上传失败')
      return
    }
    ElMessage.success(data.msg || '上传成功')
    uploadScriptVisible.value = false
    uploadScriptRawFile.value = null
    const inp = uploadNativeInputRef.value
    if (inp) inp.value = ''
    loadScripts()
  } catch (e) {
    ElMessage.error(e?.message || '网络错误')
  } finally {
    saving.value = false
  }
}
async function downloadInspectLocalTemplate(fileName) {
  const name = String(fileName || '').trim()
  if (!name) return
  let blobRes
  try {
    blobRes = await automationApi.downloadInspectTemplate({ file: name })
  } catch (e) {
    ElMessage.error(e?.message || '下载失败')
    return
  }
  const blob = blobRes instanceof Blob ? blobRes : blobRes?.data
  if (!(blob instanceof Blob)) {
    ElMessage.error('下载失败：无效的响应')
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}
async function openTaskDlg() {
  await loadCmdbInstances()
  try {
    const r = await automationApi.inspectScripts({})
    taskScriptsCache.value = Array.isArray(r?.data) ? r.data : []
  } catch {
    taskScriptsCache.value = []
  }
  Object.assign(taskForm, { taskName: '', dbType: '', instanceIds: [], scriptIds: [], cronExpr: '' })
  taskDlgVisible.value = true
}
async function saveTask() {
  if (!taskForm.taskName) return ElMessage.warning('任务名称必填')
  if (!taskForm.scriptIds || !taskForm.scriptIds.length) return ElMessage.warning('请至少选择一个巡检脚本')
  saving.value = true
  try {
    await automationApi.createInspectTask(taskForm)
    ElMessage.success('任务已创建')
    taskDlgVisible.value = false
    loadTasks()
  } catch {}
  finally {
    saving.value = false
  }
}
function viewReport(row) {
  reportDetail.value = { ...row, PAYLOAD_JSON: (() => { try { return JSON.parse(row.PAYLOAD||'{}') } catch { return {} } })() }
  reportDetailVisible.value=true
}
async function fetchInspectReportDocxBlob(reportId) {
  const blobRes = await automationApi.inspectReportDocx(reportId)
  const blob = blobRes instanceof Blob ? blobRes : blobRes?.data
  if (!(blob instanceof Blob)) {
    throw new Error('下载失败：无效响应')
  }
  return blob
}
function saveBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
async function downloadReportDocx(row) {
  if (!row?.REPORT_ID) return
  try {
    const blob = await fetchInspectReportDocxBlob(row.REPORT_ID)
    saveBlobDownload(
      blob,
      `inspect_${row.INSTANCE_NAME || 'db'}_${row.REPORT_TYPE}_${row.REPORT_ID}.docx`.replace(/[^\w.-]+/g, '_')
    )
  } catch (e) {
    ElMessage.error(e?.message || '下载失败')
  }
}

// ── FAULT ──────────────────────────────────────────────────
async function loadFaultDashboard() {
  const r = await automationApi.faultDashboard().catch(()=>null)
  if(r?.data) faultDashboard.value = r.data
}
async function loadFaultPolicies() {
  const p = {}; if(faultFilter.dbType) p.dbType=faultFilter.dbType
  faultPoliciesLoading.value = true
  try {
    const r = await automationApi.faultPolicies(p)
    faultPolicies.value = Array.isArray(r.data) ? [...r.data] : []
    return true
  } catch (e) {
    faultPolicies.value = []
    ElMessage.error(e?.message || '加载故障策略失败')
    return false
  } finally {
    faultPoliciesLoading.value = false
  }
}
async function refreshFaultPolicies() {
  const ok = await loadFaultPolicies()
  await loadFaultDashboard()
  if (ok) ElMessage.success('故障策略已刷新')
}
async function loadFaultLogs() {
  const p = {}
  if(faultLogFilter.status)    p.status    = faultLogFilter.status
  if(faultLogFilter.faultType) p.faultType = faultLogFilter.faultType
  faultLogsLoading.value = true
  try {
    const r = await automationApi.faultLogs(p)
    faultLogs.value = Array.isArray(r.data) ? [...r.data] : []
    return true
  } catch (e) {
    faultLogs.value = []
    ElMessage.error(e?.message || '加载执行历史失败')
    return false
  } finally {
    faultLogsLoading.value = false
  }
}
async function refreshFaultLogs() {
  const ok = await loadFaultLogs()
  await loadFaultDashboard()
  if (ok) ElMessage.success('执行历史已刷新')
}
function openFaultDlg(row) {
  if(row) Object.assign(faultForm,{policyId:row.POLICY_ID,policyName:row.POLICY_NAME,dbType:row.DB_TYPE,faultType:row.FAULT_TYPE,actionType:row.ACTION_TYPE,actionScript:row.ACTION_SCRIPT||'',enabled:!!row.ENABLED,conditionJson:row.CONDITION_JSON||null})
  else Object.assign(faultForm,{policyId:null,policyName:'',dbType:'MYSQL',faultType:'',actionType:'AUTO_FIX',actionScript:'',enabled:true,conditionJson:null})
  faultDlgVisible.value=true
}
async function saveFaultPolicy() {
  if(!faultForm.policyName||!faultForm.faultType) return ElMessage.warning('策略名/故障类型必填')
  if(faultForm.actionType==='HA_FAILOVER' && !faultForm.instanceIds?.length) return ElMessage.warning('HA_FAILOVER 策略必须指定适用实例')
  saving.value=true
  try {
    const payload = { ...faultForm }
    if (typeof payload.conditionJson === 'string' && payload.conditionJson.trim()) {
      try { payload.conditionJson = JSON.parse(payload.conditionJson) } catch { /* 保留原文 */ }
    }
    if(faultForm.policyId) await automationApi.updateFaultPolicy(faultForm.policyId, payload)
    else await automationApi.createFaultPolicy(payload)
    ElMessage.success('保存成功'); faultDlgVisible.value=false; loadFaultPolicies()
  } catch (e) {
    ElMessage.error(e?.message || '保存失败')
  } finally { saving.value=false }
}
async function deleteFaultPolicy(id) {
  await ElMessageBox.confirm('确认删除该故障策略？','提示',{type:'warning'}).catch(()=>{throw ''})
  await automationApi.deleteFaultPolicy(id); ElMessage.success('已删除'); loadFaultPolicies()
}
function openTriggerDlg(row) {
  triggerRow.value=row; triggerInstanceId.value=null; triggerForce.value=false; triggerPreCheck.value=null
  triggerDlgVisible.value=true
}
async function doTriggerFault() {
  if(!triggerInstanceId.value) return ElMessage.warning('请选择目标实例')
  saving.value=true
  try {
    const r = await automationApi.triggerFaultPolicy(triggerRow.value.POLICY_ID,{instanceId:triggerInstanceId.value,force:triggerForce.value})
    if(r.data?.conditionMet===false && !triggerForce.value) {
      // 条件未达阈值，展示当前指标，询问是否强制
      triggerPreCheck.value = r.data
      triggerForce.value = true
      ElMessage.warning(r.msg||'当前指标未达触发阈值，已切换为强制模式，再次确认即强制执行')
      saving.value=false; return
    }
    const detail = r.data?.detail||r.msg||'触发成功'
    const isHA = r.data?.haTopoId
    ElMessage.success(isHA ? `${detail}（已触发 HA 切换）` : detail)
    triggerDlgVisible.value=false; loadFaultLogs(); loadFaultDashboard()
    if(isHA) { loadTopologies(); loadSwitches() }
  } catch {} finally { saving.value=false }
}

// ── PUBLISH ────────────────────────────────────────────────
async function loadTickets() {
  const p = {}
  if(ticketFilter.status)     p.status     = ticketFilter.status
  if(ticketFilter.ticketType) p.ticketType = ticketFilter.ticketType
  if(ticketFilter.env)        p.env        = ticketFilter.env
  const r = await automationApi.publishTickets(p).catch(()=>({data:[]}))
  tickets.value = r.data||[]
}
async function loadDdlRules() {
  const r = await automationApi.ddlRules().catch(()=>({data:[]}))
  ddlRules.value = r.data||[]
}
async function submitTicket() {
  if(!ticketForm.title||!ticketForm.sqlContent) return ElMessage.warning('标题和SQL必填')
  saving.value=true
  try {
    const r = await automationApi.createPublishTicket(ticketForm)
    const d = r.data||{}
    if(d.blocked) {
      // CRITICAL风险被拦截
      ElMessage.error(`工单被拦截：SQL风险等级 CRITICAL，请先在SQL治理中心优化后重试。评分: ${d.score}`)
      saving.value=false; return
    }
    const riskColor = d.risk==='HIGH'?'danger': d.risk==='MEDIUM'?'warning':'success'
    ElMessage.success(`工单已提交 (${d.ticketNo})  评分: ${d.score}  风险: ${d.risk}`)
    if(d.risk==='HIGH') ElMessage.warning('提示：当前SQL存在高风险问题，已关联SQL治理审查记录，请在发布后关注执行结果')
    newTicketVisible.value=false; loadTickets()
  } catch {} finally { saving.value=false }
}
async function viewTicket(id) {
  const r = await automationApi.publishTicket(id).catch(()=>({data:null}))
  currentTicket.value = r.data; ticketDetailVisible.value=true
}
// 打开完整审核弹窗（加载工单详情）
async function reviewTicket(row, defaultAction) {
  reviewingRow.value   = row
  reviewAction.value   = defaultAction || 'APPROVE'
  reviewComment.value  = ''
  reviewingTicket.value = null
  reviewDlgVisible.value = true
  reviewLoading.value  = true
  try {
    const r = await automationApi.publishTicket(row.TICKET_ID)
    reviewingTicket.value = r.data
  } catch {} finally { reviewLoading.value = false }
}
// 提交审核决定
async function submitReview() {
  if (!reviewComment.value.trim() && reviewAction.value === 'REJECT')
    return ElMessage.warning('拒绝时请填写拒绝原因')
  saving.value = true
  try {
    await automationApi.reviewPublishTicket(reviewingRow.value.TICKET_ID, {
      action: reviewAction.value, comment: reviewComment.value
    })
    ElMessage.success(reviewAction.value === 'APPROVE' ? '✅ 审批通过，工单可执行发布' : '❌ 已拒绝，工单退回提交人')
    reviewDlgVisible.value = false
    loadTickets()
  } catch {} finally { saving.value = false }
}
function openExecDlg(row) { execRow.value=row; execGrayPct.value=row.GRAY_PERCENT||100; execDlgVisible.value=true }
async function doExecuteTicket() {
  saving.value=true
  try {
    const r = await automationApi.executePublishTicket(execRow.value.TICKET_ID,{grayPercent:execGrayPct.value})
    ElMessage.success(r.msg); execDlgVisible.value=false; loadTickets()
  } catch {} finally { saving.value=false }
}
async function rollbackTicket(row) {
  const reason = await ElMessageBox.prompt('回滚原因','回滚确认',{inputType:'textarea'}).then(v=>v.value).catch(()=>{throw ''})
  await automationApi.rollbackPublishTicket(row.TICKET_ID,{reason})
  ElMessage.success('回滚成功'); loadTickets()
}
function toggleDdlRule(row) {
  automationApi.updateDdlRule(row.RULE_ID,{enabled:!row.ENABLED}).then(()=>loadDdlRules()).catch(()=>{})
}
function openDdlRuleDlg() { Object.assign(ddlRuleForm,{ruleCode:'',ruleName:'',dbType:'ALL',severity:'WARNING',message:''}); ddlRuleDlgVisible.value=true }
async function saveDdlRule() {
  saving.value=true
  try { await automationApi.createDdlRule(ddlRuleForm); ElMessage.success('规则已添加'); ddlRuleDlgVisible.value=false; loadDdlRules() }
  catch {} finally { saving.value=false }
}

// ── SQL GOVERNANCE ─────────────────────────────────────────
async function loadSqlHealthOverview() {
  const r = await automationApi.sqlHealthOverview().catch(()=>null)
  if(r?.data) sqlHealthOverview.value = r.data
}
async function runSqlAudit() {
  if(!auditSql.value.trim()) return ElMessage.warning('请输入SQL')
  auditLoading.value=true; auditResult.value=null
  try {
    const r = await automationApi.sqlAudit({sql:auditSql.value,instanceId:auditInstanceId.value})
    auditResult.value=r.data; lastAuditId.value=r.data?.auditId
  }
  catch {} finally { auditLoading.value=false }
}
async function pushAuditToPublish() {
  if(!lastAuditId.value) return ElMessage.warning('请先执行审查')
  saving.value=true
  try {
    const r = await automationApi.pushAuditToPublish(lastAuditId.value)
    ElMessage.success(`已推送至发布流程，工单号: ${r.data?.ticketNo}`)
  } catch {} finally { saving.value=false }
}
async function pushAuditRecordToPublish(row) {
  saving.value=true
  try {
    const r = await automationApi.pushAuditToPublish(row.AUDIT_ID)
    ElMessage.success(`已推送，工单号: ${r.data?.ticketNo}`)
    loadAuditHistory()
  } catch {} finally { saving.value=false }
}
async function importSlowQueries() {
  if(!slowQueryInstanceId.value) return ElMessage.warning('请选择实例')
  importingSlowQuery.value=true
  try {
    const r = await automationApi.importSlowQueries({instanceId:slowQueryInstanceId.value})
    ElMessage.success(r.msg||`已导入 ${r.data?.imported} 条慢查询并完成审查`)
    loadAuditHistory()
  } catch {} finally { importingSlowQuery.value=false }
}
// 打开治理审核详情弹窗
async function openAuditDetail(row) {
  auditDetailRow.value = null
  auditReviewComment.value = ''
  auditDetailDlgVisible.value = true
  auditDetailLoading.value = true
  try {
    const r = await automationApi.sqlAuditDetail(row.AUDIT_ID)
    auditDetailRow.value = r.data
  } catch {} finally { auditDetailLoading.value = false }
}
// 提交人工审核结果（CONFIRM / IGNORE）
async function submitAuditReview(action) {
  saving.value = true
  try {
    const r = await automationApi.sqlAuditReview(auditDetailRow.value.AUDIT_ID, {
      action, comment: auditReviewComment.value
    })
    ElMessage.success(r.data?.msg || (action === 'CONFIRM' ? '已确认' : '已忽略'))
    // 同步更新列表中该行的 review_status
    const row = auditHistory.value.find(x => x.AUDIT_ID === auditDetailRow.value.AUDIT_ID)
    if (row) row.REVIEW_STATUS = action === 'CONFIRM' ? 'CONFIRMED' : 'IGNORED'
    auditDetailDlgVisible.value = false
  } catch {} finally { saving.value = false }
}
// 从详情弹窗直接推送发布
async function pushFromAuditDetail() {
  if (!auditDetailRow.value) return
  saving.value = true
  try {
    const r = await automationApi.pushAuditToPublish(auditDetailRow.value.AUDIT_ID)
    ElMessage.success(`已推送至发布流程，工单号: ${r.data?.ticketNo}`)
    auditDetailDlgVisible.value = false
    loadAuditHistory()
  } catch {} finally { saving.value = false }
}
async function loadAuditHistory() {
  const p = {}
  if(auditHistFilter.riskLevel)            p.riskLevel    = auditHistFilter.riskLevel
  if(auditHistFilter.source)               p.source       = auditHistFilter.source
  if(auditReviewFilter.reviewStatus)       p.reviewStatus = auditReviewFilter.reviewStatus
  const r = await automationApi.sqlAuditRecords(p).catch(()=>({data:[]}))
  auditHistory.value = r.data||[]
}
async function loadScoreConfig() {
  const r = await automationApi.sqlScoreConfig().catch(()=>({data:[]}))
  scoreConfig.value = r.data||[]
}
async function updateScoreWeight(row) {
  await automationApi.updateSqlScoreConfig(row.CONFIG_ID,{weight:row.WEIGHT}).catch(()=>{})
  ElMessage.success('权重已更新')
}
async function loadBaselines() {
  const r = await automationApi.sqlBaselines().catch(()=>({data:[]}))
  baselines.value = r.data||[]
}
async function activateBaseline(row) {
  await ElMessageBox.confirm(`确认激活基线 [${row.SQL_HASH?.slice(0,8)}...]，状态将从 CANDIDATE 变为 ACTIVE？`,'确认',{type:'info'}).catch(()=>{throw ''})
  await automationApi.activateSqlBaseline(row.BASELINE_ID)
  ElMessage.success('基线已激活'); loadBaselines()
}
async function loadRegressions() {
  const r = await automationApi.sqlRegressions().catch(()=>({data:[]}))
  regressions.value = r.data||[]
}
function openBaselineDlg() { Object.assign(baselineForm,{sqlHash:'',sqlText:'',instanceId:null,baselineType:'FIXED'}); baselineDlgVisible.value=true }
async function saveBaseline() {
  if(!baselineForm.sqlHash||!baselineForm.sqlText) return ElMessage.warning('SQL Hash 和 SQL文本必填')
  saving.value=true
  try { await automationApi.createSqlBaseline(baselineForm); ElMessage.success('基线已固化'); baselineDlgVisible.value=false; loadBaselines() }
  catch {} finally { saving.value=false }
}
async function runRegression() {
  regressionLoading.value=true
  try { const r=await automationApi.runSqlRegression({}); ElMessage.success(r.msg||'回归分析完成'); loadRegressions() }
  catch {} finally { regressionLoading.value=false }
}

// ── HA ────────────────────────────────────────────────────
async function loadHaDashboard() {
  const r = await automationApi.haDashboard().catch(()=>null)
  if(r?.data) haDashboard.value = r.data
}
async function loadTopologies() {
  const r = await automationApi.haTopologies().catch(()=>({data:[]}))
  topologies.value = r.data||[]
}
async function doHealthCheck(row) {
  healthCheckResult.value = null
  const r = await automationApi.haHealthCheck(row.TOPO_ID).catch(()=>null)
  if(r?.data) { healthCheckResult.value = r.data; ElMessage.success('健康检查完成') }
}
async function loadSwitches(topoId) {
  const p = {}
  if(topoId) p.topoId = topoId
  if(switchHistFilter.switchType) p.switchType = switchHistFilter.switchType
  const r = await automationApi.haSwitches(p).catch(()=>({data:[]}))
  switches.value = r.data||[]
}
function viewSwitchHistory(id) { haTab.value='switches'; loadSwitches(id) }
async function loadDrLinks() {
  const r = await automationApi.drLinks().catch(()=>({data:[]}))
  drLinks.value = r.data||[]
}
async function doDrDrill(link) {
  await ElMessageBox.confirm(`确认对容灾链路 [${link.LINK_NAME}] 执行容灾演练？演练将模拟主备切换流程，不影响生产数据。`,'容灾演练',{type:'info',confirmButtonText:'开始演练',cancelButtonText:'取消'}).catch(()=>{throw ''})
  drillingLink.value = link.LINK_ID
  try {
    const r = await automationApi.drDrill(link.LINK_ID)
    ElMessage.success(r.msg||'演练完成'); loadDrLinks(); loadSwitches()
  } catch {} finally { drillingLink.value=null }
}
function openTopoDlg(row) {
  if(row) Object.assign(topoForm,{topoId:row.TOPO_ID,topoName:row.TOPO_NAME,haType:row.HA_TYPE,primaryId:row.PRIMARY_ID,vip:row.VIP||''})
  else Object.assign(topoForm,{topoId:null,topoName:'',haType:'MGR',primaryId:null,vip:''})
  topoDlgVisible.value=true
}
async function saveTopology() {
  if(!topoForm.topoName) return ElMessage.warning('拓扑名称必填')
  saving.value=true
  try {
    if(topoForm.topoId) await automationApi.updateHaTopology(topoForm.topoId,topoForm)
    else await automationApi.createHaTopology(topoForm)
    ElMessage.success('保存成功'); topoDlgVisible.value=false; loadTopologies()
  } catch {} finally { saving.value=false }
}
function openSwitchDlg(row) {
  switchRow.value=row; switchForm.switchType='PLANNED'; switchForm.toNode=null
  healthCheckResult.value=null; switchDlgVisible.value=true
}
async function doHaSwitch() {
  if(!switchForm.toNode) return ElMessage.warning('请选择切换目标节点')
  const isDrill = switchForm.switchType==='DRILL'
  await ElMessageBox.confirm(
    isDrill
      ? `确认对 [${switchRow.value.TOPO_NAME}] 执行演练切换（不影响生产主库）？`
      : `确认对 [${switchRow.value.TOPO_NAME}] 执行 ${switchTypeLabel(switchForm.switchType)}？此操作将影响业务，请谨慎！`,
    isDrill?'演练确认':'高危确认',
    {type:isDrill?'info':'warning',confirmButtonText:'确认切换',cancelButtonText:'取消'}
  ).catch(()=>{throw ''})
  saving.value=true
  try {
    const r = await automationApi.haSwitch(switchRow.value.TOPO_ID,switchForm)
    const msg = r.msg||'切换成功'
    ElMessage.success(isDrill ? `演练完成: ${msg}` : msg)
    switchDlgVisible.value=false; loadTopologies(); loadSwitches(); loadHaDashboard()
    if(!isDrill) ElMessage.info('CMDB实例角色已同步更新')
  } catch {} finally { saving.value=false }
}
function openDrLinkDlg() { Object.assign(drLinkForm,{linkName:'',sourceRegion:'北京',targetRegion:'上海',sourceId:null,targetId:null,syncMode:'ASYNC',rpoSec:30,rtoSec:120}); drLinkDlgVisible.value=true }
async function saveDrLink() {
  saving.value=true
  try { await automationApi.createDrLink(drLinkForm); ElMessage.success('容灾链路已添加'); drLinkDlgVisible.value=false; loadDrLinks() }
  catch {} finally { saving.value=false }
}
async function refreshDrLink(id) {
  const r = await automationApi.refreshDrLink(id).catch(()=>({data:{}}))
  ElMessage.info(`延迟: ${r.data?.delayMs}ms  状态: ${r.data?.status}${r.data?.fromMonitor?' (实时监控数据)':''}`); loadDrLinks()
}

// ── CAPACITY ───────────────────────────────────────────────
async function loadSnapshots() {
  const p = {days:30}; if(capacityInstanceId.value) p.instanceId=capacityInstanceId.value
  const r = await automationApi.capacitySnapshots(p).catch(()=>({data:[]}))
  snapshots.value = r.data||[]
}
async function collectSnapshot() {
  if(!capacityInstanceId.value) return ElMessage.warning('请选择实例')
  collectingSnap.value=true
  try { const r=await automationApi.collectCapacitySnapshot({instanceId:capacityInstanceId.value}); ElMessage.success(r.msg||'采集成功'); loadSnapshots() }
  catch {} finally { collectingSnap.value=false }
}
async function loadForecasts() {
  const p = {}; if(capacityInstanceId.value) p.instanceId=capacityInstanceId.value
  const r = await automationApi.capacityForecasts(p).catch(()=>({data:[]}))
  forecasts.value = r.data||[]
}
async function runForecast() {
  if(!capacityInstanceId.value) return ElMessage.warning('请选择实例')
  forecastLoading.value=true
  try { const r=await automationApi.runCapacityForecast({instanceId:capacityInstanceId.value}); ElMessage.success(r.msg||'预测完成'); loadForecasts() }
  catch {} finally { forecastLoading.value=false }
}
async function loadCostAnalysis() {
  const r = await automationApi.costAnalysis().catch(()=>({data:[]}))
  costAnalysis.value = r.data||[]
}
async function runCostAnalysis() {
  costAnalysisLoading.value=true
  try { const r=await automationApi.runCostAnalysis(); ElMessage.success(r.msg||'分析完成'); loadCostAnalysis() }
  catch {} finally { costAnalysisLoading.value=false }
}

// ── BACKUP ─────────────────────────────────────────────────
async function loadBackupPolicies() {
  const r = await automationApi.backupPolicies().catch(()=>({data:[]}))
  bkPolicies.value = r.data||[]
}
async function loadBkRecords() {
  const p = {}; if(bkFilter.backupType) p.backupType=bkFilter.backupType; if(bkFilter.status) p.status=bkFilter.status
  const r = await automationApi.backupRecords(p).catch(()=>({data:[]}))
  bkRecords.value = r.data||[]
}
async function loadBkStats() {
  const r = await automationApi.backupStats().catch(()=>({data:{}}))
  bkStats.value = r.data
}
async function loadRestores() {
  const r = await automationApi.restoreTasks().catch(()=>({data:[]}))
  restores.value = r.data||[]
}
function openBkPolicyDlg(row) {
  if(row) Object.assign(bkPolicyForm,{policyId:row.POLICY_ID,policyName:row.POLICY_NAME,instanceId:row.INSTANCE_ID,backupType:row.BACKUP_TYPE,storageType:row.STORAGE_TYPE,storagePath:row.STORAGE_PATH,retentionDays:row.RETENTION_DAYS,schedule:row.SCHEDULE,compress:!!row.COMPRESS,encrypt:!!row.ENCRYPT})
  else Object.assign(bkPolicyForm,{policyId:null,policyName:'',instanceId:null,backupType:'FULL',storageType:'LOCAL',storagePath:'/backup',retentionDays:7,schedule:'0 2 * * *',compress:true,encrypt:false})
  bkPolicyDlgVisible.value=true
}
async function saveBkPolicy() {
  if(!bkPolicyForm.policyName||!bkPolicyForm.backupType) return ElMessage.warning('策略名/类型必填')
  saving.value=true
  try {
    if(bkPolicyForm.policyId) await automationApi.updateBackupPolicy(bkPolicyForm.policyId,bkPolicyForm)
    else await automationApi.createBackupPolicy(bkPolicyForm)
    ElMessage.success('保存成功'); bkPolicyDlgVisible.value=false; loadBackupPolicies()
  } catch {} finally { saving.value=false }
}
async function deleteBkPolicy(id) {
  await ElMessageBox.confirm('确认删除备份策略？','提示',{type:'warning'}).catch(()=>{throw ''})
  await automationApi.deleteBackupPolicy(id); ElMessage.success('已删除'); loadBackupPolicies()
}
async function runBackupNow(id) {
  runningBk.value=id
  try { const r=await automationApi.runBackupPolicy(id); ElMessage.success(`${r.msg}  大小: ${r.data?.sizeMB}MB  耗时: ${r.data?.durationSec}s`); loadBackupPolicies(); loadBkRecords() }
  catch {} finally { runningBk.value=null }
}
function openRestoreDlg() { Object.assign(restoreForm,{instanceId:null,restoreType:'PITR',targetTime:'',targetTable:'',flashbackScn:''}); restoreDlgVisible.value=true }
async function createRestore() {
  if(!restoreForm.instanceId) return ElMessage.warning('请选择实例')
  await ElMessageBox.confirm('恢复操作不可逆，请确认已评估影响范围！','高危确认',{type:'error',confirmButtonText:'确认执行'}).catch(()=>{throw ''})
  saving.value=true
  try {
    await automationApi.createRestoreTask(restoreForm)
    const tasks = await automationApi.restoreTasks()
    const newTask = tasks.data?.[0]
    if(newTask) { await automationApi.executeRestoreTask(newTask.RESTORE_ID); ElMessage.success('恢复任务已执行') }
    restoreDlgVisible.value=false; loadRestores()
  } catch {} finally { saving.value=false }
}
async function executeRestore(id) {
  await ElMessageBox.confirm('确认执行此恢复任务？','确认',{type:'warning'}).catch(()=>{throw ''})
  const r = await automationApi.executeRestoreTask(id)
  ElMessage.success(r.data?.detail||'恢复成功'); loadRestores()
}

/** CMDB 实例列表（分页接口返回 { list, total }，需取 list；拉足条数供各下拉使用） */
async function loadCmdbInstances() {
  const r = await cmdbApi.list({ page: 1, size: 1000 }).catch(() => ({ data: { list: [] } }))
  const d = r?.data
  instances.value = Array.isArray(d) ? d : (d?.list || [])
}

// ── Init ───────────────────────────────────────────────────
onMounted(async () => {
  await loadCmdbInstances()
  switchModule('inspect')
})
</script>

<style scoped>
.auto-pro-wrap { display:flex; height:100%; min-height:calc(100vh - 120px); gap:0 }
.auto-sidebar { width:170px; min-width:170px; background:#001529; flex-shrink:0 }
.auto-sidebar-title { color:#ffffffa0; font-size:12px; padding:16px 16px 8px; text-transform:uppercase; letter-spacing:.5px; border-bottom:1px solid #ffffff15 }
.auto-nav { border-right:none; background:#001529 !important }
.auto-nav :deep(.el-menu-item) { color:#ffffffa0; font-size:13px; height:44px; line-height:44px }
.auto-nav :deep(.el-menu-item.is-active) { color:#fff; background:#1890ff !important }
.auto-nav :deep(.el-menu-item:hover) { color:#fff; background:#ffffff15 !important }
.auto-content { flex:1; overflow:auto; padding:16px; background:#f5f7fa; min-width:0 }
.toolbar { display:flex; gap:8px; align-items:center; margin-bottom:12px; flex-wrap:wrap }
.text-success { color:#67c23a; font-weight:600 }
.text-warning { color:#e6a23c; font-weight:600 }
.text-danger  { color:#f56c6c; font-weight:600 }
.text-info    { color:#409eff }
.sql-audit-panel { display:flex; gap:16px; align-items:flex-start }
.sql-audit-left  { flex:1; min-width:0 }
.sql-audit-right { width:220px; display:flex; flex-direction:column; align-items:center; background:#fff; border:1px solid #eee; border-radius:8px; padding:16px }
.score-ring { width:100px; height:100px; border-radius:50%; display:flex; flex-direction:column; align-items:center; justify-content:center; border:6px solid; margin-bottom:8px }
.score-ring.text-success { border-color:#67c23a; color:#67c23a }
.score-ring.text-warning { border-color:#e6a23c; color:#e6a23c }
.score-ring.text-danger  { border-color:#f56c6c; color:#f56c6c }
.score-num   { font-size:28px; font-weight:700; line-height:1 }
.score-label { font-size:11px; margin-top:2px }
.audit-issue { display:flex; align-items:flex-start; gap:6px; margin:6px 0; font-size:13px; line-height:1.5 }
.dr-visual   { display:flex; flex-direction:column; gap:16px; padding:16px }
.dr-link-card{ display:flex; align-items:center; background:#fff; border:1px solid #e4e7ed; border-radius:8px; padding:20px; gap:8px }
.dr-node     { display:flex; flex-direction:column; align-items:center; gap:4px; min-width:90px }
.dr-node-name{ font-size:15px; font-weight:600; color:#303133 }
.dr-node-sub { font-size:12px; color:#909399 }
.dr-source   { color:#1890ff }
.dr-target   { color:#67c23a }
.dr-link-line{ flex:1; display:flex; flex-direction:column; align-items:center; position:relative; border-top:2px solid #e4e7ed; margin:0 8px; padding-top:8px }
.dr-link-line.dr-normal { border-color:#67c23a }
.dr-link-line.dr-lag    { border-color:#e6a23c }
.dr-link-line.dr-broken { border-color:#f56c6c }
.dr-link-info{ display:flex; flex-direction:column; align-items:center; gap:2px; font-size:12px; color:#606266 }
.dr-delay    { font-size:13px; font-weight:600 }
.dr-arrow    { font-size:20px; color:#606266 }
.stats-cards { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:16px }
.stat-card   { min-width:140px; text-align:center }
.stat-title  { font-size:12px; color:#909399; margin-bottom:4px }
.stat-value  { font-size:24px; font-weight:700 }
.stat-sub    { font-size:12px; color:#909399; margin-top:2px }
.sql-pre     { background:#f4f4f5; border-radius:4px; padding:12px; font-size:12px; overflow:auto; max-height:200px; white-space:pre-wrap; word-break:break-all }
.review-sql-pre { max-height:260px; border:1px solid #e4e7ed }
.inspect-file-item-wrap { position: relative }
.hidden-file-input { position: absolute; width: 0; height: 0; opacity: 0; pointer-events: none; }
.inspect-file-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap }
.inspect-file-name { font-size:13px; color:#606266; max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.inspect-tpl-line1 { display:block; font-weight:600; font-size:13px; line-height:1.35 }
.inspect-tpl-line2 { display:block; font-size:12px; color:#909399; max-width:360px; white-space:normal; line-height:1.35; margin-top:4px }
.task-run-alert { margin-bottom:12px }
.task-run-section-title { font-size:13px; font-weight:600; margin:12px 0 8px; color:#303133 }
.task-run-log-pre { background:#f4f4f5; border-radius:4px; padding:12px; font-size:12px; max-height:360px; overflow:auto; white-space:pre-wrap; word-break:break-all; margin:0; font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace }
.review-sql-pre { max-height:260px; border:1px solid #e4e7ed }
.fault-dashboard-bar { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:12px; padding:12px; background:#fff; border-radius:8px; border:1px solid #e4e7ed }
.dashboard-stat { min-width:90px; text-align:center }
.ds-value { font-size:20px; font-weight:700 }
</style>

<style>
/* 下拉挂载在 body：补充菜单项两行说明样式 */
.inspect-template-download-menu.el-popper .inspect-tpl-line1 { font-weight: 600; font-size: 13px; display: block; }
.inspect-template-download-menu.el-popper .inspect-tpl-line2 { font-size: 12px; color: #909399; max-width: 360px; white-space: normal; line-height: 1.35; margin-top: 4px; display: block; }
</style>
