-- 007_login_throttle.sql
--
-- 登录防爆破：按（用户名哈希 或 客户端 IP）统计窗口内失败次数。
-- 用户名存哈希而非明文，避免安全日志本身变成账号清单。
-- 幂等：全部语句可重复执行。

BEGIN;

CREATE TABLE IF NOT EXISTS login_attempt (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username_hash TEXT NOT NULL,
    ip_address    TEXT,
    attempted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    succeeded     BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS login_attempt_username_idx ON login_attempt (username_hash, attempted_at DESC);
CREATE INDEX IF NOT EXISTS login_attempt_ip_idx ON login_attempt (ip_address, attempted_at DESC);

COMMENT ON TABLE login_attempt IS '登录尝试记录（含失败），用于防爆破锁定与安全审计；username_hash=sha256(规范化用户名)。';

COMMIT;
