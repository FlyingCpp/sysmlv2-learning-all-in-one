package org.sysmlv2.learning.validator;

import java.util.*;

/** General 卡片的全部文本在官方字体环境测量，不从 SVG 反推。 */
final class GeneralViewPresentation {
    @SuppressWarnings("unchecked")
    static Map<String, Object> prepare(Map<String, Object> source) {
        Map<String, Object> result = new LinkedHashMap<>(source);
        result.put("fontFamily", "Noto Sans CJK SC");
        result.put("fontSize", 14);
        List<Map<String, Object>> ports = (List<Map<String, Object>>) source.get("ports");
        for (Map<String, Object> node : (List<Map<String, Object>>) source.get("nodes")) {
            List<Map<String, Object>> rows = new ArrayList<>();
            rows.addAll(DiagramProjection.wrap("«" + node.get("role")
                + (Boolean.TRUE.equals(node.get("isDefinition")) ? " def" : "") + "»", 330));
            rows.addAll((List<Map<String, Object>>) node.get("labelLines"));
            if (node.containsKey("reqId") && !"".equals(node.get("reqId"))) rows.addAll(DiagramProjection.wrap("id = " + node.get("reqId"), 330));
            boolean heading = false;
            for (Map<String, Object> port : ports) if (port.get("ownerId").equals(node.get("id"))) {
                if (!heading) { section(rows, "ports"); heading = true; }
                for (Map<String, Object> line : (List<Map<String, Object>>) port.get("labelLines")) {
                    Map<String, Object> row = new LinkedHashMap<>(line);
                    row.put("sourceElementId", port.get("sourceElementId"));
                    rows.add(row);
                }
            }
            if (node.containsKey("details")) for (Map<String, Object> detail : (List<Map<String, Object>>) node.get("details")) {
                section(rows, String.valueOf(detail.get("kind")));
                rows.addAll((List<Map<String, Object>>) detail.get("lines"));
            }
            List<Map<String, Object>> docs = (List<Map<String, Object>>) node.get("documentationLines");
            if (docs != null && !docs.isEmpty()) { section(rows, "doc"); rows.addAll(docs); }
            node.put("cardRows", rows);
        }
        List<Map<String, Object>> edges = new ArrayList<>();
        for (Map<String, Object> original : (List<Map<String, Object>>) source.get("edges")) {
            Map<String, Object> edge = new LinkedHashMap<>(original);
            String label = switch (String.valueOf(edge.get("kind"))) {
                case "feature-typing" -> "defined by";
                case "required-reference" -> "require ref";
                case "assumed-reference" -> "assume ref";
                case "required-requirement" -> "require";
                case "reference-part" -> "ref part";
                default -> "";
            };
            edge.put("labelLines", DiagramProjection.wrap(label, 220));
            edges.add(edge);
        }
        result.put("edges", edges);
        return result;
    }

    private static void section(List<Map<String, Object>> rows, String title) {
        for (Map<String, Object> line : DiagramProjection.wrap(title, 330)) {
            Map<String, Object> row = new LinkedHashMap<>(line);
            row.put("separator", true);
            rows.add(row);
        }
    }
}
