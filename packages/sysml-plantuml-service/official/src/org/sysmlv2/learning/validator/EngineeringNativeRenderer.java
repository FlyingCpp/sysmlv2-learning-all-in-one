package org.sysmlv2.learning.validator;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import net.sourceforge.plantuml.SourceStringReader;
import net.sourceforge.plantuml.FileFormat;
import net.sourceforge.plantuml.FileFormatOption;

/** 官方模型投影和官方 PUMLCODE 共用皮肤；几何由 PlantUML 原生图种计算。 */
final class EngineeringNativeRenderer {
    static final String SKIN = """
        ' 共用工程皮肤：不改变节点、关系、消息和状态的定义。
        skinparam monochrome false
        skinparam backgroundColor #FFFFFF
        skinparam defaultFontName Noto Sans CJK SC
        skinparam defaultFontSize 14
        skinparam defaultFontColor #253247
        skinparam hyperlinkColor #253247
        skinparam hyperlinkUnderline false
        skinparam classFontStyle plain
        skinparam shadowing false
        skinparam roundCorner 16
        skinparam ArrowColor #344B63
        skinparam ArrowThickness 1.5
        skinparam Padding 12
        skinparam nodesep 35
        skinparam ranksep 35
        skinparam rectangle {
          BackgroundColor #FFFFFF
          BorderColor #60748A
          FontColor #253247
          BorderThickness 1.5
          BackgroundColor<<block>> #F8FAFC
        }
        skinparam class {
          BackgroundColor #FFFFFF
          BorderColor #60748A
          FontColor #253247
        }
        skinparam state {
          BackgroundColor #FFFFFF
          BorderColor #60748A
          FontColor #253247
          StartColor #344B63
          EndColor #344B63
        }
        skinparam note {
          BackgroundColor #FFFDF5
          BorderColor #CABD92
          FontColor #253247
        }
        skinparam sequence {
          ParticipantBackgroundColor #FFFFFF
          ParticipantBorderColor #60748A
          ParticipantFontColor #253247
          LifeLineBorderColor #60748A
          LifeLineBackgroundColor #F8FAFC
          ArrowColor #344B63
          ArrowFontColor #253247
          BoxBackgroundColor #F8FAFC
          BoxBorderColor #60748A
          GroupBackgroundColor #F8FAFC
          GroupBorderColor #60748A
          MessageAlign center
        }
        <style>
        root {
          FontName Noto Sans CJK SC
          FontSize 14
          FontColor #253247
          LineColor #60748A
          LineThickness 1.5
          BackGroundColor #FFFFFF
          Shadowing 0
          RoundCorner 16
        }
        note {
          BackGroundColor #FFFDF5
          LineColor #CABD92
        }
        arrow {
          LineColor #344B63
          FontColor #253247
        }
        sequenceDiagram {
          FontName Noto Sans CJK SC
          FontSize 14
          FontColor #253247
          LineColor #60748A
          participant {
            FontName Noto Sans CJK SC
            FontSize 14
            FontColor #253247
            BackGroundColor #FFFFFF
            LineColor #60748A
            RoundCorner 16
            Padding 12
          }
          arrow {
            FontName Noto Sans CJK SC
            FontSize 14
            FontColor #253247
            LineColor #344B63
          }
          box {
            BackGroundColor #F8FAFC
            LineColor #60748A
          }
          lifeLine {
            LineColor #60748A
          }
        }
        </style>
        """;

    static String applySkin(String source, String mode) {
        // 官方生成器的头部先声明默认皮肤。必须在首个图元之前覆盖，时序图解析时即捕获样式。
        java.util.regex.Matcher first = java.util.regex.Pattern.compile("(?m)^(?:rec\\b|rectangle|class|abstract|interface|package|state|box|participant|actor|boundary|control|entity|database|collections|queue|note|title|E[0-9]+\\b)[^\\r\\n]*").matcher(source);
        int index = first.find() ? first.start() : source.lastIndexOf("@enduml");
        if (index < 0) throw new IllegalArgumentException("INVALID_NATIVE_SOURCE");
        // 原生动作图的参数引线、参数名与数据流标签需要共同的层间留白。
        String spacing = "ACTION".equals(mode) ? "skinparam ranksep 70\n" : "";
        return source.substring(0, index) + SKIN + "\n" + spacing + source.substring(index);
    }

    static String render(String source) throws java.io.IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        new SourceStringReader(source).outputImage(output, new FileFormatOption(FileFormat.SVG));
        return output.toString(StandardCharsets.UTF_8);
    }

    static String browser(Map<String, Object> document) {
        StringBuilder out = new StringBuilder("@startuml\n").append(SKIN)
            .append("\nhide circle\nskinparam classAttributeIconSize 0\n")
            .append("class \"BrowserView · 成员层级\" as browser {\n");
        for (Map<String, Object> node : items(document, "nodes")) {
            int depth = ((Number) node.get("depth")).intValue();
            String label = String.valueOf(node.get("name"));
            if (!"".equals(node.get("typeName"))) label += " : " + node.get("typeName");
            out.append("{field} ").append("　".repeat(depth)).append(depth == 0 ? "" : "└ ")
                .append("[[psysml:").append(node.get("sourceElementId")).append(" ")
                .append(literal(label)).append("]]\n");
        }
        return out.append("}\n@enduml\n").toString();
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> items(Map<String, Object> document, String key) {
        return (List<Map<String, Object>>) document.get(key);
    }

    private static String literal(Object value) {
        // 文本不能成为预处理器、链接或 Creole 指令；只保留显示字符。
        return String.valueOf(value == null ? "" : value).replace("&", "&#38;").replace("\"", "&#34;")
            .replace("\\", "&#92;").replace("[", "&#91;").replace("]", "&#93;")
            .replace("<", "&#60;").replace(">", "&#62;").replace("\n", " ").replace("\r", " ");
    }
}
