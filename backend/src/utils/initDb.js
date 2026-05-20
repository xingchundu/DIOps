/**
 * 平台数据库初始化辅助脚本
 * 用途：通过 Node.js 检测数据库连接并验证表结构
 * 执行：node src/utils/initDb.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') })
const oracledb = require('oracledb')

const config = {
  user:          process.env.DB_USER,
  password:      process.env.DB_PASSWORD,
  connectString: `${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_SID}`,
}

const REQUIRED_TABLES = [
  'SYS_USER', 'SYS_AUDIT_LOG', 'CMDB_INSTANCE', 'CMDB_HOST',
  'ALERT_RULE', 'ALERT_RECORD', 'SQL_SLOW_SUMMARY', 'INSPECT_RESULT',
  'BACKUP_POLICY', 'BACKUP_RECORD',
  'DEPLOY_TEMPLATE', 'DEPLOY_JOB', 'HA_SWITCH_PLAN', 'HA_SWITCH_AUDIT',
  'RUNBOOK_DEF', 'RUNBOOK_EXEC_LOG', 'SELF_HEAL_POLICY',
  'OPS_SERVICE_CATALOG', 'OPS_SERVICE_ORDER', 'SPACE_POLICY',
  'SCRIPT_REPO', 'SCRIPT_EXEC_LOG', 'AUTOMATION_INSPECT_BATCH', 'AUTOMATION_EXEC_LOG',
  'INSPECT_CHECKV8_REPORT',
  'MONITOR_METRIC_SAMPLE',
]

async function main() {
  console.log('\n========================================')
  console.log(' 数据库智能平台 - 初始化检测')
  console.log('========================================')
  console.log(`\n连接信息: ${config.user}@${config.connectString}`)

  let conn
  try {
    conn = await oracledb.getConnection(config)
    console.log('✅ 数据库连接成功\n')

    // 检查表是否存在
    console.log('检查平台表结构...')
    const existRes = await conn.execute(
      `SELECT TABLE_NAME FROM USER_TABLES WHERE TABLE_NAME IN (${REQUIRED_TABLES.map((_, i) => `:${i+1}`).join(',')})`,
      REQUIRED_TABLES,
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    )
    const existingTables = existRes.rows.map(r => r.TABLE_NAME)
    const missingTables  = REQUIRED_TABLES.filter(t => !existingTables.includes(t))

    if (missingTables.length === 0) {
      console.log('✅ 所有平台表已存在\n')
    } else {
      console.log(`⚠️  以下表不存在（需执行 sql/init.sql）:\n   ${missingTables.join(', ')}\n`)
      console.log('执行方式:')
      console.log(`  sqlplus ${config.user}/${process.env.DB_PASSWORD}@${config.connectString} @sql/init.sql\n`)
    }

    // 检查管理员账号
    const adminRes = await conn.execute(
      `SELECT COUNT(*) C FROM SYS_USER WHERE ROLE='ADMIN'`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    ).catch(() => ({ rows: [{ C: 'N/A（表不存在）' }] }))
    console.log(`管理员账号数: ${adminRes.rows[0].C}`)

    // 检查实例数
    const instRes = await conn.execute(
      `SELECT COUNT(*) C FROM CMDB_INSTANCE`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    ).catch(() => ({ rows: [{ C: 'N/A' }] }))
    console.log(`已纳管实例数: ${instRes.rows[0].C}`)

    // 当前用户权限
    const privRes = await conn.execute(
      `SELECT PRIVILEGE FROM USER_SYS_PRIVS WHERE ROWNUM <= 10`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    )
    console.log(`\n当前用户系统权限: ${privRes.rows.map(r => r.PRIVILEGE).join(', ') || '（无系统权限）'}`)

    console.log('\n========================================')
    if (missingTables.length === 0) {
      console.log(' ✅ 平台数据库初始化完成，可以启动服务')
    } else {
      console.log(' ⚠️  请先执行 sql/init.sql 完成初始化')
    }
    console.log('========================================\n')
  } catch (err) {
    console.error('\n❌ 连接失败:', err.message)
    console.error('\n排查方法:')
    console.error(`  1. 检查 .env 配置: DB_HOST/PORT/SID/USER/PASSWORD`)
    console.error(`  2. 测试网络连通性: telnet ${process.env.DB_HOST} ${process.env.DB_PORT}`)
    console.error(`  3. 确认 Oracle Instant Client 已安装`)
    console.error(`  4. 检查 LD_LIBRARY_PATH 是否包含 Instant Client 路径\n`)
    process.exit(1)
  } finally {
    if (conn) await conn.close()
  }
}

main()
