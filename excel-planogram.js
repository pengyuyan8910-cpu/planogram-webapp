(() => {
  "use strict";

  const MAIN_STORAGE_KEY = "planogram-webapp-state-v1";
  const LAYERS = ["D", "C", "B", "A"];
  const MIN_GRID_COLUMNS = 36;
  const GRID_START_COLUMN = 4; // D列
  const NAVY = "FF27486D";
  const BLUE = "FF2563EB";
  const PALE_BLUE = "FFE7F0FA";
  const PALE_GRAY = "FFF1F5F9";
  const BORDER = "FFB8C4D1";
  const TEXT = "FF0F172A";
  const MUTED = "FF475569";
  const WHITE = "FFFFFFFF";

  const number = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const integer = (value, fallback = 0) => Math.round(number(value, fallback));

  function readCurrentData() {
    try {
      const raw = window.localStorage.getItem(MAIN_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.products) || !Array.isArray(parsed.groups)) return null;
      return parsed;
    } catch (error) {
      console.error("读取当前门店数据失败。", error);
      return null;
    }
  }

  function currentCategory() {
    const metric = document.getElementById("metricCategory")?.textContent?.trim();
    if (metric && metric !== "—") return metric;
    const active = document.querySelector(".category-bar button.active");
    return active?.textContent?.trim() || "当前品类";
  }

  function currentStoreName() {
    return window.PLANOGRAM_STORE_CONTEXT?.storeName
      || document.querySelector(".topbar .eyebrow")?.textContent?.trim()
      || "当前门店";
  }

  function safeSheetName(value, fallback) {
    const cleaned = String(value || fallback || "工作表")
      .replace(/[\\/?*\[\]:]/g, "_")
      .slice(0, 31);
    return cleaned || fallback || "工作表";
  }

  function safeFileName(value) {
    return String(value || "可编辑陈列图").replace(/[\\/:*?"<>|]/g, "_");
  }

  function excelColumnName(columnNumber) {
    let value = columnNumber;
    let name = "";
    while (value > 0) {
      const remainder = (value - 1) % 26;
      name = String.fromCharCode(65 + remainder) + name;
      value = Math.floor((value - 1) / 26);
    }
    return name;
  }

  function getLayer(group, layer) {
    const source = group?.layers?.[layer] || {};
    return {
      capacity: Math.max(1, integer(source.capacity, 1200)),
      pits: Array.isArray(source.pits) ? source.pits : []
    };
  }

  function pitMaximum(product, layer) {
    const depth = Math.max(1, integer(product?.depthCount, 1));
    const height = Math.max(1, integer(product?.height, 1));
    const stack = layer === "A" ? Math.max(1, Math.floor(910 / height)) : 1;
    return { maximum: depth * stack, depth, stack };
  }

  function moduleText(product, pit, layer, pitIndex, pitCount) {
    const capacity = pitMaximum(product, layer);
    const type = pit?.kind === "expansion" ? "扩陈坑位" : "基础坑位";
    const capacityParts = [`最多${capacity.maximum}箱`];
    if (capacity.depth > 1) capacityParts.push(`纵深${capacity.depth}箱`);
    if (layer === "A" && capacity.stack > 1) capacityParts.push(`堆叠${capacity.stack}箱`);
    return [
      product?.name || "未匹配SKU",
      product?.barcode ? `条码 ${product.barcode}` : `SKU ${pit?.productId || "—"}`,
      `${product?.grade || "—"}级｜${product?.newFlag || "—"}｜${type} ${pitIndex + 1}/${pitCount}`,
      `满陈${integer(product?.shelfBoxes, 0)}箱｜${capacityParts.join("，")}`,
      `${integer(product?.faceWidth, 0)}×${integer(product?.depth, 0)}×${integer(product?.height, 0)}mm｜周转${number(product?.turnoverDays, 0)}天`
    ].join("\n");
  }

  function allocateGridWidths(pits, productsById, capacity, gridColumns) {
    if (!pits.length) return [];
    const physicalWidths = pits.map(pit => Math.max(1, integer(productsById.get(pit.productId)?.faceWidth, 1)));
    const used = physicalWidths.reduce((sum, value) => sum + value, 0);
    const target = Math.min(
      gridColumns,
      Math.max(pits.length, Math.round((Math.min(used, capacity) / capacity) * gridColumns))
    );
    const allocations = Array(pits.length).fill(1);
    let remaining = target - pits.length;
    if (remaining <= 0) return allocations;

    const weightTotal = physicalWidths.reduce((sum, value) => sum + value, 0) || 1;
    const exactExtras = physicalWidths.map(value => (value / weightTotal) * remaining);
    exactExtras.forEach((value, index) => {
      const floorValue = Math.floor(value);
      allocations[index] += floorValue;
      remaining -= floorValue;
    });

    const order = exactExtras
      .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
      .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
    let cursor = 0;
    while (remaining > 0 && order.length) {
      allocations[order[cursor % order.length].index] += 1;
      cursor += 1;
      remaining -= 1;
    }
    return allocations;
  }


  function gridColumnsForGroups(groups) {
    let columns = MIN_GRID_COLUMNS;
    groups.forEach(group => {
      LAYERS.forEach(layer => {
        const layerData = getLayer(group, layer);
        const physicalShelves = Math.max(
          1,
          integer(group.physicalShelfCount, Math.round(layerData.capacity / 1200) || 1)
        );
        columns = Math.max(
          columns,
          Math.ceil(layerData.capacity / 100),
          layerData.pits.length + Math.max(4, physicalShelves)
        );
      });
    });
    return Math.min(180, columns);
  }

  function physicalShelfForPit(group, layerData, productsById, pitIndex) {
    const sourceIds = Array.isArray(group.sourceGroupIds) && group.sourceGroupIds.length
      ? group.sourceGroupIds
      : [group.id];
    if (sourceIds.length <= 1) return sourceIds[0] || group.id || "";
    const perShelf = Math.max(1, Math.round(layerData.capacity / sourceIds.length));
    let cursor = 0;
    for (let index = 0; index <= pitIndex; index += 1) {
      if (index === pitIndex) {
        return sourceIds[Math.min(sourceIds.length - 1, Math.floor(cursor / perShelf))] || sourceIds[sourceIds.length - 1];
      }
      const pit = layerData.pits[index];
      cursor += Math.max(0, integer(productsById.get(pit.productId)?.faceWidth, 0));
    }
    return sourceIds[sourceIds.length - 1] || group.id || "";
  }

  function applyThinBorder(cell) {
    cell.border = {
      top: { style: "thin", color: { argb: BORDER } },
      left: { style: "thin", color: { argb: BORDER } },
      bottom: { style: "thin", color: { argb: BORDER } },
      right: { style: "thin", color: { argb: BORDER } }
    };
  }

  function styleMergedRange(worksheet, startRow, startColumn, endRow, endColumn, config = {}) {
    const startAddress = `${excelColumnName(startColumn)}${startRow}`;
    const endAddress = `${excelColumnName(endColumn)}${endRow}`;
    if (startRow !== endRow || startColumn !== endColumn) worksheet.mergeCells(`${startAddress}:${endAddress}`);
    const cell = worksheet.getCell(startRow, startColumn);
    cell.value = config.value ?? "";
    cell.alignment = config.alignment || { vertical: "middle", horizontal: "center", wrapText: true };
    cell.font = config.font || { name: "Microsoft YaHei", size: 10, color: { argb: TEXT } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: config.fill || WHITE } };
    applyThinBorder(cell);
    return cell;
  }

  function addVisualSheet(workbook, data, category, storeName) {
    const groups = data.groups.filter(group => group.category === category);
    const gridColumns = gridColumnsForGroups(groups);
    const gridEndColumn = GRID_START_COLUMN + gridColumns - 1;
    const sheet = workbook.addWorksheet(safeSheetName(`陈列图_${category}`, "陈列图"), {
      views: [{ state: "frozen", ySplit: 3 }],
      pageSetup: {
        orientation: "landscape",
        paperSize: 8,
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        margins: { left: 0.25, right: 0.25, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 }
      }
    });

    sheet.properties.defaultRowHeight = 18;
    sheet.getColumn(1).width = 4.5;
    sheet.getColumn(2).width = 7;
    sheet.getColumn(3).width = 8;
    for (let column = GRID_START_COLUMN; column <= gridEndColumn; column += 1) {
      sheet.getColumn(column).width = gridColumns > 100 ? 2.2 : (gridColumns > 60 ? 2.8 : 3.6);
    }

    const endColumnName = excelColumnName(gridEndColumn);
    sheet.mergeCells(`A1:${endColumnName}1`);
    const title = sheet.getCell("A1");
    title.value = `${storeName}｜${category}｜可编辑Excel陈列图`;
    title.font = { name: "Microsoft YaHei", size: 18, bold: true, color: { argb: WHITE } };
    title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    title.alignment = { vertical: "middle", horizontal: "left" };
    sheet.getRow(1).height = 34;

    sheet.mergeCells(`A2:${endColumnName}2`);
    const note = sheet.getCell("A2");
    note.value = "每个商品坑位均为可编辑单元格；白色为基础坑位，浅蓝色为扩陈坑位。修改此Excel不会自动回传小程序。";
    note.font = { name: "Microsoft YaHei", size: 10, color: { argb: MUTED } };
    note.fill = { type: "pattern", pattern: "solid", fgColor: { argb: PALE_GRAY } };
    note.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
    sheet.getRow(2).height = 26;

    const productsById = new Map(data.products.map(product => [product.id, product]));
    let row = 4;

    groups.forEach((group, groupIndex) => {
      const headerEnd = gridEndColumn;
      const headerCell = styleMergedRange(sheet, row, 1, row, headerEnd, {
        value: `${group.secondCategory || "未分类"}｜${group.id}｜${group.type || "标准货架"}｜${integer(group.physicalShelfCount, 1)}节连续`,
        fill: NAVY,
        font: { name: "Microsoft YaHei", size: 12, bold: true, color: { argb: WHITE } },
        alignment: { vertical: "middle", horizontal: "left" }
      });
      headerCell.border = {
        top: { style: "thin", color: { argb: NAVY } },
        left: { style: "thin", color: { argb: NAVY } },
        bottom: { style: "thin", color: { argb: NAVY } },
        right: { style: "thin", color: { argb: NAVY } }
      };
      sheet.getRow(row).height = 24;
      row += 1;

      LAYERS.forEach(layer => {
        const layerData = getLayer(group, layer);
        const allocations = allocateGridWidths(layerData.pits, productsById, layerData.capacity, gridColumns);
        const used = layerData.pits.reduce((sum, pit) => sum + Math.max(0, integer(productsById.get(pit.productId)?.faceWidth, 0)), 0);
        const remainingMm = Math.max(0, layerData.capacity - used);

        styleMergedRange(sheet, row, 1, row, 3, {
          value: `${layer}层\n容量 ${layerData.capacity}mm\n已用 ${used}mm\n余量 ${remainingMm}mm`,
          fill: PALE_GRAY,
          font: { name: "Microsoft YaHei", size: 10, bold: true, color: { argb: TEXT } }
        });

        let currentColumn = GRID_START_COLUMN;
        layerData.pits.forEach((pit, pitIndex) => {
          if (currentColumn > gridEndColumn) return;
          const allocated = Math.max(1, allocations[pitIndex] || 1);
          const endColumn = Math.min(gridEndColumn, currentColumn + allocated - 1);
          const product = productsById.get(pit.productId) || {
            id: pit.productId,
            name: "未匹配SKU",
            barcode: pit.barcode || ""
          };
          styleMergedRange(sheet, row, currentColumn, row, endColumn, {
            value: moduleText(product, pit, layer, pitIndex, layerData.pits.length),
            fill: pit.kind === "expansion" ? PALE_BLUE : WHITE,
            font: {
              name: "Microsoft YaHei",
              size: 9,
              bold: true,
              color: { argb: pit.kind === "expansion" ? BLUE : TEXT }
            },
            alignment: { vertical: "middle", horizontal: "left", wrapText: true }
          });
          currentColumn = endColumn + 1;
        });

        if (currentColumn <= gridEndColumn) {
          styleMergedRange(sheet, row, currentColumn, row, gridEndColumn, {
            value: remainingMm > 0 ? `余量 ${remainingMm}mm` : "",
            fill: PALE_GRAY,
            font: { name: "Microsoft YaHei", size: 9, color: { argb: MUTED } },
            alignment: { vertical: "middle", horizontal: "center", wrapText: true }
          });
        }
        sheet.getRow(row).height = layer === "A" ? 96 : 88;
        row += 1;
      });

      if (groupIndex < groups.length - 1) {
        sheet.getRow(row).height = 10;
        row += 1;
      }
    });

    if (!groups.length) {
      sheet.mergeCells(`A4:${endColumnName}6`);
      sheet.getCell("A4").value = "当前一级类目没有货架组。";
      sheet.getCell("A4").alignment = { vertical: "middle", horizontal: "center" };
    }

    sheet.autoFilter = undefined;
    sheet.headerFooter.oddFooter = `&L${storeName}&C${category} 可编辑陈列图&R第 &P / &N 页`;
    return sheet;
  }

  function addDetailSheet(workbook, data, category, storeName) {
    const sheet = workbook.addWorksheet(safeSheetName(`陈列明细_${category}`, "陈列明细"), {
      views: [{ state: "frozen", ySplit: 1 }]
    });
    const headers = [
      "门店", "一级类目", "二级类目", "三级类目", "连续货架带", "货架类型", "连续节数", "包含货架节",
      "实际货架节（按横向位置计算）", "层级", "坑位顺序", "坑位类型", "SKU名称", "条码", "等级", "新老品",
      "正面宽度mm", "深度mm", "高度mm",
      "满陈箱数", "单坑最大箱数", "纵深箱数", "堆叠箱数", "计划坑位数", "基础坑位数", "周转天数",
      "层容量mm", "层已用mm", "层余量mm", "SKU ID", "坑位ID"
    ];
    sheet.addRow(headers);

    const productsById = new Map(data.products.map(product => [product.id, product]));
    data.groups.filter(group => group.category === category).forEach(group => {
      LAYERS.forEach(layer => {
        const layerData = getLayer(group, layer);
        const layerUsed = layerData.pits.reduce((sum, pit) => sum + Math.max(0, integer(productsById.get(pit.productId)?.faceWidth, 0)), 0);
        layerData.pits.forEach((pit, index) => {
          const product = productsById.get(pit.productId) || {};
          const capacity = pitMaximum(product, layer);
          sheet.addRow([
            storeName,
            category,
            group.secondCategory || "",
            product.thirdCategory || pit.thirdCategory || group.thirdCategory || "",
            group.id || "",
            group.type || "",
            integer(group.physicalShelfCount, 1),
            (group.sourceGroupIds || [group.id]).join("、"),
            physicalShelfForPit(group, layerData, productsById, index),
            layer,
            index + 1,
            pit.kind === "expansion" ? "扩陈坑位" : "基础坑位",
            product.name || "未匹配SKU",
            product.barcode || pit.barcode || "",
            product.grade || "",
            product.newFlag || "",
            integer(product.faceWidth, 0),
            integer(product.depth, 0),
            integer(product.height, 0),
            integer(product.shelfBoxes, 0),
            capacity.maximum,
            capacity.depth,
            capacity.stack,
            integer(product.plannedPits, 0),
            integer(product.basePits, 0),
            number(product.turnoverDays, 0),
            layerData.capacity,
            layerUsed,
            layerData.capacity - layerUsed,
            product.id || pit.productId || "",
            pit.id || ""
          ]);
        });
      });
    });

    const header = sheet.getRow(1);
    header.height = 28;
    header.eachCell(cell => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
      cell.font = { name: "Microsoft YaHei", size: 10, bold: true, color: { argb: WHITE } };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      applyThinBorder(cell);
    });

    sheet.eachRow((currentRow, rowNumber) => {
      if (rowNumber === 1) return;
      currentRow.height = 22;
      currentRow.eachCell(cell => {
        cell.font = { name: "Microsoft YaHei", size: 9, color: { argb: TEXT } };
        cell.alignment = { vertical: "middle", horizontal: "left", wrapText: false };
        applyThinBorder(cell);
      });
    });

    const widths = [18, 12, 16, 16, 18, 12, 10, 28, 20, 8, 10, 12, 30, 18, 8, 10, 13, 10, 10, 12, 14, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12];
    widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
    sheet.autoFilter = { from: "A1", to: `${excelColumnName(headers.length)}${Math.max(1, sheet.rowCount)}` };
    return sheet;
  }

  async function exportCurrentCategoryExcel() {
    const button = document.getElementById("exportPdfBtn");
    const originalText = button?.textContent || "导出当前Excel陈列图";
    try {
      if (!window.ExcelJS) throw new Error("Excel组件尚未加载，请联网刷新页面后重试。");
      const data = readCurrentData();
      if (!data) throw new Error("未读取到当前门店陈列数据。");
      const category = currentCategory();
      const storeName = currentStoreName();
      const groups = data.groups.filter(group => group.category === category);
      if (!groups.length) throw new Error("当前一级类目没有可导出的货架陈列图。");

      if (button) {
        button.disabled = true;
        button.textContent = "正在生成Excel…";
      }

      const workbook = new window.ExcelJS.Workbook();
      workbook.creator = "全品类可视化陈列系统";
      workbook.lastModifiedBy = storeName;
      workbook.created = new Date();
      workbook.modified = new Date();
      workbook.subject = `${storeName} ${category} 可编辑陈列图`;
      workbook.title = `${storeName}_${category}_可编辑陈列图`;
      workbook.company = "生活馆";

      addVisualSheet(workbook, data, category, storeName);
      addDetailSheet(workbook, data, category, storeName);

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      const date = new Date().toISOString().slice(0, 10);
      link.download = safeFileName(`${storeName}_${category}_可编辑陈列图_${date}.xlsx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);

      const status = document.getElementById("statusBar");
      if (status) {
        status.textContent = `已导出“${category}”可编辑Excel陈列图：含可视化陈列图和陈列明细两个工作表。`;
        status.classList.remove("error");
      }
    } catch (error) {
      console.error(error);
      const status = document.getElementById("statusBar");
      if (status) {
        status.textContent = error.message || "Excel陈列图导出失败。";
        status.classList.add("error");
      } else {
        window.alert(error.message || "Excel陈列图导出失败。");
      }
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  }

  function installExcelExport() {
    const button = document.getElementById("exportPdfBtn");
    if (!button || button.dataset.excelPlanogramBound === "1") return;
    button.dataset.excelPlanogramBound = "1";
    button.textContent = "导出当前品类Excel陈列图";
    button.title = "导出当前一级类目的可编辑Excel陈列图";
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      exportCurrentCategoryExcel();
    }, true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installExcelExport);
  } else {
    installExcelExport();
  }
})();
