package org.sysmlv2.learning.validator;

import java.util.*;
import java.util.regex.*;
import org.omg.sysml.lang.sysml.*;
import org.omg.sysml.util.FeatureUtil;

/** 修复原生视图遗漏的关系；端点来自官方对象，PUML 只提供显示身份和上下文。 */
final class NativeRelationProjection {
    private static final Pattern DECLARATION = Pattern.compile("\\bas (E\\d+)\\b.*?\\[\\[psysml:([^\\s\\]]+)");
    private static final Pattern EDGE = Pattern.compile("^(E\\d+)\\s+([-*.<>\\[\\]#=a-zA-Z0-9,]+)\\s+(E\\d+)\\b.*");
    private static final Pattern REFERENCE = Pattern.compile("\\[\\[psysml:([^\\s\\]]+)");
    private final List<Slot> slots = new ArrayList<>();
    private final List<Map<String, Object>> relations = new ArrayList<>();
    private final Set<String> existing = new HashSet<>();
    private final StringBuilder additions = new StringBuilder();

    static Result repair(String source, Element root, String mode) {
        if (!List.of("INTERCONNECTION", "DEFAULT", "ACTION").contains(mode)) return new Result(source, List.of());
        NativeRelationProjection p = new NativeRelationProjection();
        Map<String, Element> elements = new HashMap<>();
        elements.put(root.getElementId(), root);
        root.eResource().getAllContents().forEachRemaining(o -> {
            if (o instanceof Element e) elements.put(e.getElementId(), e);
        });
        // 官方原生路径也可能把 := / default 的引用画成 '='；保留值分栏，移除错误的永久绑定线。
        source = source.lines().filter(line -> {
            Matcher edge = EDGE.matcher(line), reference = REFERENCE.matcher(line);
            if (!edge.matches() || !reference.find()) return true;
            Element element = elements.get(reference.group(1));
            return !(element instanceof FeatureValue value) || (!value.isInitial() && !value.isDefault());
        }).collect(java.util.stream.Collectors.joining("\n"));
        Deque<Slot> stack = new ArrayDeque<>();
        for (String line : source.split("\\R")) {
            Matcher declaration = DECLARATION.matcher(line);
            if (declaration.find()) {
                Slot slot = new Slot(declaration.group(1), elements.get(declaration.group(2)), stack.peek());
                p.slots.add(slot);
                if (line.stripTrailing().endsWith("{")) stack.push(slot);
            } else if (line.strip().equals("}") && !stack.isEmpty()) {
                stack.pop();
            }
            Matcher edge = EDGE.matcher(line);
            Matcher reference = REFERENCE.matcher(line);
            if (edge.matches() && reference.find()) p.existing.add(pair(edge.group(1), edge.group(3)) + "|" + reference.group(1));
        }
        for (Slot slot : p.slots) {
            if (slot.element instanceof Feature feature) {
                FeatureValue value = FeatureUtil.getValuationFor(feature);
                // 初值、默认值、常量和计算表达式不伪装成永久的二元绑定。
                if (value != null && !value.isInitial() && !value.isDefault()
                        && (value.getValue() instanceof FeatureReferenceExpression || value.getValue() instanceof FeatureChainExpression)) {
                    p.add(value, slot, p.resolve(value.getValue(), slot, 0), "value-binding", "-[thickness=5]-", "=");
                }
            }
            if (slot.element instanceof Type type) {
                for (Feature feature : type.getFeature()) {
                    if (!(feature instanceof Connector connector) || feature.isImpliedIncluded()
                            || feature.eResource() != root.eResource()) continue;
                    // 状态/时序/流的专用语法继续由官方 renderer 负责，不降格为 connection。
                    boolean binding = connector instanceof BindingConnector;
                    if (!binding && (!(connector instanceof ConnectionUsage) || connector instanceof FlowUsage)) continue;
                    List<Feature> ends = connector.getRelatedFeature();
                    if (ends.size() != 2) {
                        p.record(feature, null, null, binding ? "binding" : "connection", "unsupported-nary");
                        continue;
                    }
                    p.add(feature, p.resolve(ends.get(0), slot, 0), p.resolve(ends.get(1), slot, 0),
                        binding ? "binding" : "connection", binding ? "-[thickness=5]-" : "-[thickness=3]-", binding ? "=" : "");
                }
            }
        }
        if (mode.equals("INTERCONNECTION")) {
            Set<String> boundParameters = new HashSet<>();
            boolean parameterCards = false;
            for (Map<String, Object> relation : p.relations) if (relation.get("kind").equals("value-binding")) {
                boundParameters.add((String) relation.get("source"));
                boundParameters.add((String) relation.get("target"));
            }
            // 动作参数不是 SysML port。原生 portin/out 的标签会挤入外层 part 标题；
            // 对有绑定的参数使用 PlantUML 原生小矩形，保持参数身份、方向及所属动作。
            for (Slot slot : p.slots) {
                if (!boundParameters.contains(slot.alias) || !(slot.element instanceof Feature feature)
                        || feature instanceof PortUsage || slot.parent == null
                        || !(slot.parent.element instanceof ActionUsage || slot.parent.element instanceof ActionDefinition)) continue;
                source = source.replaceAll("(?m)^port(in|out)( [^\r\n]+? as " + slot.alias + ")\\b",
                    "rectangle$2 <<$1>>");
                parameterCards = true;
            }
            if (parameterCards) source = source.replaceFirst("\\A@startuml\\b", "@startuml\nleft to right direction\nskinparam linetype ortho");
        }
        int end = source.lastIndexOf("\n@enduml");
        if (end < 0) throw new IllegalArgumentException("NATIVE_DIAGRAM_TERMINATOR_MISSING");
        return new Result(source.substring(0, end + 1) + p.additions + source.substring(end + 1), p.relations);
    }

    private void add(Element relation, Slot source, Slot target, String kind, String line, String label) {
        if (source == null || target == null) {
            record(relation, source, target, kind, "unresolved-or-not-visible");
            return;
        }
        // 两个端点可以拥有多个独立的连接/绑定；只去除同一语义关系的重复输出。
        String key = pair(source.alias, target.alias) + "|" + relation.getElementId();
        boolean added = existing.add(key);
        if (added) additions.append(source.alias).append(' ').append(line).append(' ').append(target.alias)
            .append(" [[psysml:").append(relation.getElementId()).append("]] ")
            .append(label.isEmpty() ? "" : ": " + label).append('\n');
        record(relation, source, target, kind, added ? "added" : "present");
    }

    private void record(Element relation, Slot source, Slot target, String kind, String status) {
        relations.add(Map.of("sourceElementId", relation.getElementId(), "kind", kind, "status", status,
            "source", source == null ? "" : source.alias, "target", target == null ? "" : target.alias));
    }

    private Slot resolve(Feature feature, Slot context, int depth) {
        if (feature == null || depth > 32) return null;
        if (feature instanceof FeatureChainExpression expression) {
            if (expression.getArgument().size() != 1) return null;
            Slot owner = resolve(expression.getArgument().get(0), context, depth + 1);
            return child(owner, expression.getTargetFeature());
        }
        if (feature instanceof FeatureReferenceExpression expression) return resolve(expression.getReferent(), context, depth + 1);
        List<Feature> chain = feature.getChainingFeature();
        if (!chain.isEmpty()) {
            Slot result = resolve(chain.get(0), context, depth + 1);
            for (int i = 1; i < chain.size(); i++) result = child(result, chain.get(i));
            return result;
        }
        // 从当前 occurrence 向外逐层寻找；绝不凭名字或相同类型跨分支选端口。
        for (Slot scope = context; scope != null; scope = scope.parent) {
            if (same(scope.element, feature)) return scope;
            Slot candidate = child(scope, feature);
            if (candidate != null) return candidate;
        }
        List<Slot> roots = slots.stream().filter(s -> s.parent == null && same(s.element, feature)).toList();
        if (roots.size() == 1) return roots.get(0);
        Feature target = feature.getFeatureTarget();
        return target != null && target != feature ? resolve(target, context, depth + 1) : null;
    }

    private Slot child(Slot owner, Feature feature) {
        if (owner == null || feature == null) return null;
        List<Slot> found = slots.stream().filter(s -> s.parent == owner && same(s.element, feature)).toList();
        return found.size() == 1 ? found.get(0) : null;
    }

    private static boolean same(Element a, Element b) {
        return a != null && b != null && (a == b || a.getElementId().equals(b.getElementId()));
    }

    private static String pair(String a, String b) { return a.compareTo(b) < 0 ? a + "|" + b : b + "|" + a; }
    private record Slot(String alias, Element element, Slot parent) {}
    record Result(String source, List<Map<String, Object>> relations) {}
}
