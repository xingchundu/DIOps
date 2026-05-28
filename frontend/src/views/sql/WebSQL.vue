<template>
  <div class="workbench-wrap">
    <!-- 顶部工具栏 -->
    <div class="wb-toolbar">
      <div class="toolbar-left">
        <el-select v-model="selectedInstance" filterable placeholder="选择实例" style="width:240px" @change="onInstanceChange">
          <el-option v-for="inst in instances" :key="inst.INSTANCE_ID"
            :label="`${inst.INSTANCE_NAME} (${inst.DB_TYPE})`" :value="inst.INSTANCE_ID" />
        </el-select>
        <el-button-group style="margin-left:12px">
          <el-button type="primary" :loading="executing" @click="executeSql" :disabled="!selectedInstance || !sqlText.trim()">
            <el-icon><CaretRight /></el-icon>执行 (F8)
          </el-button>
          <el-button :loading="explaining" @click="explainSql" :disabled="!selectedInstance || !sqlText.trim()">
            <el-icon><View /></el-icon>执行计划
          </el-button>
        </el-button-group>
        <el-checkbox v-model="allowDangerous" style="margin-left:12px">允许 DDL/DML</el-checkbox>
        <el-button-group style="margin-left:8px">
          <el-button size="small" @click="formatSql">格式化</el-button>
          <el-button size="small" @click="clearEditor">清空</el-button>
        </el-button-group>
      </div>
      <div class="toolbar-right">
        <el-tag v-if="execResult" type="success" size="small">
          {{ execResult.rowCount ?? execResult.rowsAffected }} 行 · {{ execResult.elapsed }}ms
          <span v-if="execResult.truncated" style="color:#e6a23c"> (已截断)</span>
        </el-tag>
        <el-tag v-if="execResult?.dbType" size="small" type="info">{{ execResult.dbType }}</el-tag>
      </div>
    </div>

    <div class="wb-main">
      <!-- 左侧 Schema 浏览器 -->
      <div class="wb-schema" :class="{ collapsed: schemaCollapsed }">
        <div class="schema-header" @click="schemaCollapsed = !schemaCollapsed">
          <el-icon><Grid /></el-icon>
          <span v-if="!schemaCollapsed">Schema</span>
          <el-icon size="12"><ArrowLeft v-if="!schemaCollapsed" /><ArrowRight v-else /></el-icon>
        </div>
        <div v-if="!schemaCollapsed" class="schema-body">
          <el-input v-model="schemaFilter" placeholder="搜索表名..." size="small" clearable style="margin-bottom:8px" />
          <el-tree
            :data="schemaTree"
            :props="{ label: 'label', children: 'children' }"
            :filter-node-method="filterNode"
            ref="schemaTreeRef"
            node-key="id"
            highlight-current
            @node-click="onSchemaNodeClick"
            v-loading="schemaLoading"
            style="font-size:12px"
          />
        </div>
      </div>

      <!-- 中间区域：编辑器 + 结果 -->
      <div class="wb-center">
        <!-- CodeMirror SQL 编辑器 -->
        <div class="wb-editor">
          <div class="editor-header">
            <span>SQL 编辑器</span>
            <div style="display:flex;gap:4px">
              <el-button link size="small" @click="insertSnippet('SELECT * FROM ')">SELECT</el-button>
              <el-button link size="small" @click="insertSnippet('INSERT INTO  VALUES ()')">INSERT</el-button>
              <el-button link size="small" @click="insertSnippet('UPDATE  SET  WHERE ')">UPDATE</el-button>
            </div>
          </div>
          <div ref="editorContainer" class="cm-container"></div>
        </div>

        <!-- 结果面板 -->
        <div class="wb-result" v-loading="executing || explaining">
          <!-- Tab 切换 -->
          <div class="result-tabs">
            <span :class="{'tab-active': resultTab==='data'}" @click="resultTab='data'">查询结果</span>
            <span :class="{'tab-active': resultTab==='plan'}" @click="resultTab='plan'">执行计划</span>
            <span :class="{'tab-active': resultTab==='history'}" @click="resultTab='history'; loadHistory()">历史</span>
            <span :class="{'tab-active': resultTab==='messages'}" @click="resultTab='messages'">消息</span>
          </div>

          <!-- 数据结果表 -->
          <div v-show="resultTab==='data'" class="result-content">
            <div v-if="!execResult && !execError" class="empty-hint">执行 SQL 查看结果</div>
            <div v-else-if="execError" class="error-msg">{{ execError }}</div>
            <div v-else-if="execResult">
              <el-table :data="execResult.rows" stripe border size="small" max-height="100%" style="width:100%">
                <el-table-column type="index" width="50" label="#" />
                <el-table-column v-for="col in execResult.columns" :key="col" :prop="col" :label="col" min-width="120" show-overflow-tooltip>
                  <template #default="{ row }">
                    <span :class="{ 'null-val': row[col] === null }">{{ row[col] === null ? 'NULL' : row[col] }}</span>
                  </template>
                </el-table-column>
              </el-table>
            </div>
          </div>

          <!-- 执行计划 -->
          <div v-show="resultTab==='plan'" class="result-content">
            <div v-if="!planResult" class="empty-hint">点击「执行计划」查看</div>
            <div v-else>
              <div v-if="planResult.dbType === 'ORACLE' || planResult.dbType === 'DAMENG'">
                <pre class="plan-text">{{ planResult.plan?.join('\n') }}</pre>
              </div>
              <el-table v-else :data="planResult.plan" stripe size="small" border>
                <el-table-column v-for="col in (planResult.plan?.length ? Object.keys(planResult.plan[0]) : [])" :key="col" :prop="col" :label="col" min-width="100" show-overflow-tooltip />
              </el-table>
            </div>
          </div>

          <!-- 历史记录 -->
          <div v-show="resultTab==='history'" class="result-content">
            <el-table :data="historyList" stripe size="small" max-height="100%">
              <el-table-column prop="INSTANCE_NAME" label="实例" width="120" />
              <el-table-column prop="SQL_TEXT" label="SQL" min-width="250" show-overflow-tooltip />
              <el-table-column prop="ROW_COUNT" label="行数" width="70" />
              <el-table-column prop="ELAPSED_MS" label="耗时" width="70">
                <template #default="{ row }">{{ row.ELAPSED_MS }}ms</template>
              </el-table-column>
              <el-table-column label="时间" width="140">
                <template #default="{ row }">{{ fmtTime(row.CREATED_AT) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="70">
                <template #default="{ row }">
                  <el-button link size="small" @click="loadSqlToEditor(row.SQL_TEXT)">加载</el-button>
                </template>
              </el-table-column>
            </el-table>
            <div style="padding:8px 0;text-align:right">
              <el-pagination v-model:current-page="historyPage" :page-size="20" :total="historyTotal"
                layout="total,prev,pager,next" @current-change="loadHistory" small />
            </div>
          </div>

          <!-- 消息 -->
          <div v-show="resultTab==='messages'" class="result-content">
            <div v-if="messages.length === 0" class="empty-hint">暂无消息</div>
            <div v-for="(msg, i) in messages" :key="i" class="msg-item" :class="msg.type">
              <span class="msg-time">{{ msg.time }}</span>
              <span>{{ msg.text }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { workbenchApi } from '@/api/index.js'
import { ElMessage } from 'element-plus'

// CodeMirror 6 imports
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, highlightActiveLineGutter } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { sql, SQLite, MySQL, PostgreSQL, PLSQL, MSSQL } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import { foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldKeymap } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { lintKeymap } from '@codemirror/lint'

const instances = ref([])
const selectedInstance = ref(null)
const sqlText = ref('')
const allowDangerous = ref(false)
const executing = ref(false)
const explaining = ref(false)
const execResult = ref(null)
const execError = ref('')
const planResult = ref(null)
const resultTab = ref('data')
const messages = ref([])

// CodeMirror editor
const editorContainer = ref(null)
let editorView = null
const languageConf = new Compartment()

// Schema
const schemaCollapsed = ref(false)
const schemaFilter = ref('')
const schemaTreeRef = ref()
const schemaLoading = ref(false)
const schemaTree = ref([])

// History
const historyList = ref([])
const historyPage = ref(1)
const historyTotal = ref(0)

// DB type -> CodeMirror SQL dialect mapping
const dialectMap = {
  ORACLE: PLSQL,
  MYSQL: MySQL,
  POSTGRES: PostgreSQL,
  DAMENG: PLSQL,
  SQLITE: SQLite,
  MSSQL: MSSQL,
}

// Custom SQL completions from schema
let schemaCompletions = []

watch(schemaFilter, val => { schemaTreeRef.value?.filter(val) })

function filterNode(value, data) {
  if (!value) return true
  return data.label?.toLowerCase().includes(value.toLowerCase())
}

function addMsg(text, type = 'info') {
  messages.value.unshift({ text, type, time: new Date().toLocaleTimeString('zh-CN') })
  if (messages.value.length > 100) messages.value.pop()
}

function fmtTime(v) { return v ? new Date(v).toLocaleString('zh-CN') : '-' }

function getDialect(dbType) {
  return dialectMap[dbType?.toUpperCase()] || SQL
}

function createEditor(extensions = []) {
  if (editorView) editorView.destroy()
  const baseTheme = EditorView.theme({
    '&': { height: '100%', fontSize: '13px' },
    '.cm-scroller': { fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', 'Monaco', monospace" },
    '.cm-content': { padding: '8px 0' },
    '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid var(--el-border-color-lighter)' },
  })
  const state = EditorState.create({
    doc: sqlText.value,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      rectangularSelection(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        ...lintKeymap,
        indentWithTab,
        { key: 'F8', run: () => { executeSql(); return true } },
        { key: 'Ctrl-Enter', run: () => { executeSql(); return true } },
        { key: 'Cmd-Enter', run: () => { executeSql(); return true } },
      ]),
      languageConf.of(sql({ dialect: SQL, schema: buildSchemaSource(), upperCaseKeywords: true })),
      oneDark,
      baseTheme,
      EditorView.updateListener.of(update => {
        if (update.docChanged) {
          sqlText.value = update.state.doc.toString()
        }
      }),
      ...extensions,
    ],
  })
  editorView = new EditorView({ state, parent: editorContainer.value })
}

function buildSchemaSource() {
  const src = {}
  for (const owner of schemaTree.value) {
    const tables = {}
    for (const child of owner.children || []) {
      tables[child.label] = []
    }
    src[owner.label] = tables
  }
  return src
}

function updateEditorDialect(dbType) {
  if (!editorView) return
  const dialect = getDialect(dbType)
  editorView.dispatch({
    effects: languageConf.reconfigure(sql({ dialect, schema: buildSchemaSource(), upperCaseKeywords: true })),
  })
}

function loadSqlToEditor(text) {
  sqlText.value = text
  if (editorView) {
    editorView.dispatch({
      changes: { from: 0, to: editorView.state.doc.length, insert: text },
    })
  }
}

async function loadInstances() {
  try {
    const r = await workbenchApi.instances()
    instances.value = r.data || []
  } catch { instances.value = [] }
}

async function onInstanceChange(id) {
  if (!id) { schemaTree.value = []; return }
  schemaLoading.value = true
  try {
    const r = await workbenchApi.schema(id)
    const tables = r.data?.tables || []
    const ownerMap = {}
    for (const t of tables) {
      const owner = t.OWNER || t.owner || 'DEFAULT'
      const name = t.OBJECT_NAME || t.object_name || ''
      const type = t.OBJECT_TYPE || t.object_type || 'TABLE'
      if (!ownerMap[owner]) ownerMap[owner] = []
      ownerMap[owner].push({ label: `${type === 'VIEW' ? '👁 ' : ''}${name}`, name, owner, type, id: `${owner}.${name}` })
    }
    schemaTree.value = Object.entries(ownerMap).map(([owner, children]) => ({
      label: `${owner} (${children.length})`, id: owner, children,
    }))
    addMsg(`已加载 Schema: ${tables.length} 个对象`, 'success')
    // Update editor schema for autocompletion
    if (editorView) {
      const inst = instances.value.find(i => i.INSTANCE_ID === id)
      updateEditorDialect(inst?.DB_TYPE)
    }
  } catch (e) {
    schemaTree.value = []
    addMsg(`Schema 加载失败: ${e.message}`, 'error')
  }
  schemaLoading.value = false
}

async function onSchemaNodeClick(data) {
  if (!data.owner || !data.name) return
  insertAtCursor(`${data.owner}.${data.name}`)
  try {
    const r = await workbenchApi.columns(selectedInstance.value, { owner: data.owner, table: data.name })
    const cols = r.data?.columns || []
    if (cols.length) {
      const colNames = cols.map(c => c.COLUMN_NAME || c.column_name)
      addMsg(`${data.owner}.${data.name} 列: ${colNames.join(', ')}`, 'info')
      // Add columns to autocompletion
      const inst = instances.value.find(i => i.INSTANCE_ID === selectedInstance.value)
      if (editorView) {
        editorView.dispatch({
          effects: languageConf.reconfigure(sql({
            dialect: getDialect(inst?.DB_TYPE),
            schema: { ...buildSchemaSource(), [data.owner]: { [data.name]: colNames } },
            upperCaseKeywords: true,
          })),
        })
      }
    }
  } catch {}
}

function insertAtCursor(text) {
  if (!editorView) return
  const { from } = editorView.state.selection.main
  editorView.dispatch({
    changes: { from, insert: text },
    selection: { anchor: from + text.length },
  })
  editorView.focus()
}

function insertSnippet(text) { insertAtCursor(text) }

async function executeSql() {
  if (!selectedInstance.value || !sqlText.value.trim()) return
  executing.value = true
  execError.value = ''
  execResult.value = null
  resultTab.value = 'data'
  addMsg(`执行: ${sqlText.value.substring(0, 100)}...`, 'info')

  try {
    const r = await workbenchApi.execute({
      instanceId: selectedInstance.value,
      sql: sqlText.value.trim(),
      allowDangerous: allowDangerous.value,
    })
    if (r.code === 200) {
      execResult.value = r.data
      addMsg(`执行完成: ${r.data.rowCount ?? r.data.rowsAffected} 行, ${r.data.elapsed}ms`, 'success')
    } else {
      execError.value = r.msg
      addMsg(`执行失败: ${r.msg}`, 'error')
      resultTab.value = 'messages'
    }
  } catch (e) {
    execError.value = e.message
    addMsg(`执行异常: ${e.message}`, 'error')
  }
  executing.value = false
}

async function explainSql() {
  if (!selectedInstance.value || !sqlText.value.trim()) return
  explaining.value = true
  planResult.value = null
  resultTab.value = 'plan'

  try {
    const r = await workbenchApi.explain({
      instanceId: selectedInstance.value,
      sql: sqlText.value.trim(),
    })
    if (r.code === 200) {
      planResult.value = r.data
      addMsg(`执行计划获取成功`, 'success')
    } else {
      addMsg(`执行计划失败: ${r.msg}`, 'error')
      resultTab.value = 'messages'
    }
  } catch (e) {
    addMsg(`执行计划异常: ${e.message}`, 'error')
  }
  explaining.value = false
}

async function loadHistory() {
  try {
    const r = await workbenchApi.history({
      instanceId: selectedInstance.value || undefined,
      page: historyPage.value, size: 20,
    })
    historyList.value = r.data?.list || r.data?.rows || r.data || []
    historyTotal.value = r.data?.total || 0
  } catch {}
}

function formatSql() {
  const keywords = ['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'ORDER BY', 'GROUP BY', 'HAVING', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'TABLE', 'INDEX', 'VIEW', 'AS', 'IN', 'NOT', 'NULL', 'IS', 'BETWEEN', 'LIKE', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'LIMIT', 'OFFSET', 'UNION', 'ALL', 'DISTINCT', 'TOP', 'FETCH', 'FIRST', 'ROWS', 'ONLY', 'ASC', 'DESC']
  let formatted = sqlText.value
  for (const kw of keywords) {
    formatted = formatted.replace(new RegExp(`\\b${kw}\\b`, 'gi'), kw)
  }
  formatted = formatted.replace(/\s+(SELECT|FROM|WHERE|AND|OR|ORDER BY|GROUP BY|HAVING|JOIN|LEFT JOIN|RIGHT JOIN|INNER JOIN|LIMIT)\s+/gi, '\n$1 ')
  loadSqlToEditor(formatted.trim())
}

function clearEditor() {
  loadSqlToEditor('')
  execResult.value = null
  execError.value = ''
  planResult.value = null
}

onMounted(() => { loadInstances(); createEditor() })
onUnmounted(() => { if (editorView) editorView.destroy() })
</script>

<style scoped>
.workbench-wrap { display: flex; flex-direction: column; height: calc(100vh - 56px); overflow: hidden; }

.wb-toolbar {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 16px; border-bottom: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color); flex-shrink: 0;
}
.toolbar-left { display: flex; align-items: center; gap: 8px; }
.toolbar-right { display: flex; align-items: center; gap: 8px; }

.wb-main { display: flex; flex: 1; overflow: hidden; }

/* Schema 浏览器 */
.wb-schema {
  width: 240px; border-right: 1px solid var(--el-border-color-lighter);
  display: flex; flex-direction: column; background: var(--el-bg-color);
  transition: width 0.2s;
}
.wb-schema.collapsed { width: 40px; }
.schema-header {
  display: flex; align-items: center; gap: 6px; padding: 8px 12px;
  cursor: pointer; font-size: 13px; font-weight: 600;
  border-bottom: 1px solid var(--el-border-color-lighter);
  color: var(--el-text-color-regular);
}
.schema-header:hover { background: var(--el-fill-color-light); }
.schema-body { flex: 1; overflow-y: auto; padding: 8px; }

/* 中间区域 */
.wb-center { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

/* CodeMirror 编辑器容器 */
.wb-editor { flex-shrink: 0; border-bottom: 1px solid var(--el-border-color-lighter); display: flex; flex-direction: column; }
.editor-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 4px 12px; font-size: 12px; color: var(--el-text-color-secondary);
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.cm-container {
  height: 240px; overflow: auto;
}
.cm-container :deep(.cm-editor) {
  height: 100%;
}
.cm-container :deep(.cm-scroller) {
  overflow: auto;
}

/* 结果面板 */
.wb-result { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.result-tabs {
  display: flex; gap: 0; padding: 0 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color); flex-shrink: 0;
}
.result-tabs span {
  padding: 8px 16px; font-size: 13px; cursor: pointer;
  color: var(--el-text-color-secondary); border-bottom: 2px solid transparent;
  transition: all 0.2s;
}
.result-tabs span:hover { color: var(--el-color-primary); }
.tab-active { color: var(--el-color-primary) !important; border-bottom-color: var(--el-color-primary) !important; font-weight: 600; }
.result-content { flex: 1; overflow: auto; padding: 8px 12px; }

.empty-hint { text-align: center; color: var(--el-text-color-placeholder); padding: 40px 0; font-size: 13px; }
.error-msg { color: var(--el-color-danger); padding: 12px; background: #fef0f0; border-radius: 4px; font-size: 13px; white-space: pre-wrap; }
.plan-text { font-family: monospace; font-size: 12px; line-height: 1.6; white-space: pre; color: var(--el-text-color-primary); }
.null-val { color: var(--el-text-color-placeholder); font-style: italic; }

.msg-item { padding: 4px 0; font-size: 12px; border-bottom: 1px solid var(--el-border-color-extra-light); }
.msg-item.error { color: var(--el-color-danger); }
.msg-item.success { color: var(--el-color-success); }
.msg-time { color: var(--el-text-color-secondary); margin-right: 8px; font-size: 11px; }
</style>
