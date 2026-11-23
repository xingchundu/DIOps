/**
 * Express 4 不捕获 async 路由抛出的异常（Promise rejection）：请求会一直挂起，Node 15+ 进程还可能直接退出。
 * 这里给路由层打补丁，把 rejection 交给 next(err)，由全局错误处理返回 500（作用同 express-async-errors）。
 */
const Layer = require('express/lib/router/layer');

if (!Layer.prototype.__diopsAsyncPatched) {
  const orig = Layer.prototype.handle_request;
  Layer.prototype.handle_request = function handleRequest(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return orig.call(this, req, res, next); // 错误处理中间件
    try {
      const ret = fn(req, res, next);
      if (ret && typeof ret.then === 'function' && typeof ret.catch === 'function') {
        ret.catch(err => next(err || new Error('请求处理失败')));
      }
    } catch (err) {
      next(err);
    }
    return undefined;
  };
  Layer.prototype.__diopsAsyncPatched = true;
}

module.exports = {};
