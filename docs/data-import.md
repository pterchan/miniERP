# XLSX 数据导入

导入工具接受任意结构的 XLSX 工作簿，通过 JSON 映射文件把源工作表和列映射到 miniERP 的标准字段。默认只生成干运行报告；只有显式传入 --apply 才写入数据库。导入数据仍需人工审核后才能进入正式库存流水。

## 映射文件

仓库提供 examples/import-map.example.json。映射文件版本为 1，根对象包含 version 与 sheets。每个 sheets 项包含：

- name：工作簿中的实际工作表名称。
- role：products、movement、assets 或 stage_only。
- header_row：表头所在行，从 1 开始，默认值为 1。
- columns：标准字段名称到工作簿列标题的映射。
- movement_type：role 为 movement 时必填，指定该表流水类型。

每份映射恰好配置一个 products 工作表。产品列可映射 identifier、name、uom、opening_quantity、existing_quantity。流水列可映射 identifier、name、date、quantity、uom、note、destination、serial。资产列可映射 name、serial、component_serial、notes。stage_only 可映射需要保留的字段；只会导出显式选择的列并应用脱敏规则。

流水类型使用数据库的标准代码，例如 RECEIPT、ISSUE_OTHER、TRANSFER、RETURN 和 ADJUSTMENT。TRANSFER 仍按备注与去向中的明确关键词分类；无法安全判断的行进入 REVIEW。未映射的工作表仅在摘要中列出名称和非空行数，原始内容不会写入报告。

列标题会在去除首尾空白并做 Unicode NFKC 规范化后匹配；工作表名称按工作簿中的名称匹配。工作表或映射列不存在、映射版本不受支持、角色配置不合法时会给出明确错误。行数据缺少日期、数量或货品标识时保留为质量问题，不会猜测补齐。产品的期初量和现存量是可选映射；只有配置了相应列但单元格为空或无效时才登记质量问题。

## 干运行

    IMPORT_WORKBOOK_PASSWORD='<密码>' python3 scripts/import_inventory.py \
      --input <工作簿.xlsx> \
      --mapping examples/import-map.example.json \
      --output /tmp/mini-erp-import

产物包括 report.json，以及产品观察、流水候选、资产观察和暂存记录的 JSONL 文件。映射决定哪些列进入报告；凭据、联系方式、电话和财务敏感内容继续按源列标题及文本规则排除或遮蔽，包括以数字格式存储的电话号码。加密工作簿只在临时目录解密，处理完成即删除。

## 审核后写库

    IMPORT_WORKBOOK_PASSWORD='<密码>' DATABASE_URL='<数据库连接串>' \
      python3 scripts/seed_inventory.py \
      --input <工作簿.xlsx> \
      --mapping examples/import-map.example.json \
      --apply

不带 --apply 时只解析并打印摘要。先检查干运行报告，再决定是否执行写库。写库按工作簿 SHA-256 与来源行幂等，冲突和异常数据留在人工裁决队列；符合规则且货品可唯一匹配的收货和常见出库会在 `--apply` 时过账，调货、退货、盘点和其他不明确类型需要人工复核。正期初量默认不会自动过账；只有审核后使用 --post-opening --cutover-date <日期> 才能生成期初流水。

## 数据治理约定

1. 不虚构期初余额与日期；不确定的数据进入质量或冲突队列。
2. 不做隐式单位换算；数量保存字典单位与来源单位。
3. 来源编号仅作可冲突的标识观察，数据库主键由系统生成。
4. 已过账流水不可变，纠错走红冲；全程审计。
