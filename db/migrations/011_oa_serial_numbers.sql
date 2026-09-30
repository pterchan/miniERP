BEGIN;

-- 旧申请不回填 SN；新明细沿用业务单据的可选登记语义。
ALTER TABLE stock_request_line ADD COLUMN IF NOT EXISTS serial_numbers TEXT[];
COMMENT ON COLUMN stock_request_line.serial_numbers IS '可选序列号清单；放行时与库存流水及单件事件同事务登记。';

COMMIT;
