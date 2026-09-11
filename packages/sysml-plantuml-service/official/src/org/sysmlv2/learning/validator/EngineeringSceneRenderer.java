package org.sysmlv2.learning.validator;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.sourceforge.plantuml.FileFormat;
import net.sourceforge.plantuml.FileFormatOption;
import net.sourceforge.plantuml.graphic.FontConfiguration;
import net.sourceforge.plantuml.style.ClockwiseTopRightBottomLeft;
import net.sourceforge.plantuml.ugraphic.*;
import net.sourceforge.plantuml.ugraphic.color.*;

/** 将已通过几何检查的场景交给固定版本 PlantUML 绘图后端；不重新布局。 */
final class EngineeringSceneRenderer {
    private static final HColor STROKE = HColorSet.instance().getColorOrWhite("#344b63");
    private static final HColor WHITE = HColorSet.instance().getColorOrWhite("#ffffff");

    private static double number(JsonObject object, String key) { return object.get(key).getAsDouble(); }
    private static String text(JsonObject object, String key) { return object.get(key).getAsString(); }
    private static void group(UGraphic graphic, String id) { graphic.startGroup(Map.of(UGroupType.ID, id)); }

    private static void label(UGraphic graphic, JsonObject line, double x, double y, UFont font) {
        graphic.apply(new UTranslate(x, y)).draw(new UText(text(line, "text"),
            FontConfiguration.create(font, STROKE, STROKE, false)));
    }

    private static void draw(UGraphic graphic, JsonObject scene) {
        UFont font = new UFont(text(scene, "fontFamily"), 0, 14);
        if (text(scene, "profile").endsWith("-hierarchy")) { drawGeneral(graphic, scene, font); return; }
        JsonArray nodes = scene.getAsJsonArray("nodes");
        for (JsonElement element : nodes) {
            JsonObject node = element.getAsJsonObject();
            double x = number(node, "x"), y = number(node, "y"), width = number(node, "width"), height = number(node, "height");
            boolean container = false;
            for (JsonElement child : nodes) if (text(child.getAsJsonObject(), "parentId").equals(text(node, "id"))) container = true;
            group(graphic, text(node, "id"));
            graphic.startUrl(new net.sourceforge.plantuml.Url("psysml:" + text(node, "sourceElementId"), text(node, "sourceRef")));
            graphic.apply(new UTranslate(x, y)).apply(STROKE).apply(new UStroke(1.5))
                .apply(HColorSet.instance().getColorOrWhite(container ? "#f8fafc" : "#ffffff").bg())
                .draw(new URectangle(width, height).rounded(container ? 8 : 20));
            int index = 0;
            for (JsonElement item : node.getAsJsonArray("labelLines")) {
                JsonObject line = item.getAsJsonObject();
                label(graphic, line, x + (width - number(line, "width")) / 2, y + 23 + index++ * 20, font);
            }
            graphic.closeUrl();
            graphic.closeGroup();
        }
        for (JsonElement element : scene.getAsJsonArray("edges")) {
            JsonObject edge = element.getAsJsonObject();
            UPath route = new UPath();
            JsonArray points = edge.getAsJsonArray("points");
            for (int i = 0; i < points.size(); i++) {
                JsonObject point = points.get(i).getAsJsonObject();
                if (i == 0) route.moveTo(number(point, "x"), number(point, "y"));
                else route.lineTo(number(point, "x"), number(point, "y"));
            }
            group(graphic, text(edge, "id"));
            graphic.apply(STROKE).apply(new UStroke(1.6)).draw(route);
            if (text(edge, "kind").equals("succession")) {
                JsonObject end = points.get(points.size() - 1).getAsJsonObject();
                JsonObject before = points.get(points.size() - 2).getAsJsonObject();
                double x = number(end, "x"), y = number(end, "y");
                double dx = Math.signum(x - number(before, "x")), dy = Math.signum(y - number(before, "y"));
                UPolygon arrow = new UPolygon();
                arrow.addPoint(x, y); arrow.addPoint(x - dx * 9 + dy * 4, y - dy * 9 - dx * 4);
                arrow.addPoint(x - dx * 9 - dy * 4, y - dy * 9 + dx * 4);
                graphic.apply(STROKE).apply(STROKE.bg()).draw(arrow);
            }
            graphic.closeGroup();
        }
        for (JsonElement element : scene.getAsJsonArray("ports")) {
            JsonObject port = element.getAsJsonObject();
            double x = number(port, "x"), y = number(port, "y");
            group(graphic, text(port, "id"));
            graphic.startUrl(new net.sourceforge.plantuml.Url("psysml:" + text(port, "sourceElementId"), text(port, "sourceRef")));
            graphic.apply(new UTranslate(x, y)).apply(STROKE).apply(WHITE.bg()).apply(new UStroke(1.5))
                .draw(new URectangle(number(port, "width"), number(port, "height")));
            JsonArray lines = port.getAsJsonArray("labelLines");
            for (int i = 0; i < lines.size(); i++) {
                JsonObject line = lines.get(i).getAsJsonObject();
                label(graphic, line, text(port, "side").equals("WEST") ? x + 24 : x - 14 - number(line, "width"),
                    y + 10 - (lines.size() - 1) * 10 + i * 20, font);
            }
            graphic.closeUrl();
            graphic.closeGroup();
        }
        double noteY = number(scene, "height") + 24;
        for (JsonElement element : nodes) {
            JsonObject node = element.getAsJsonObject();
            JsonArray lines = node.getAsJsonArray("documentationLines");
            if (!text(node, "parentId").isEmpty() || lines.size() == 0) continue;
            double width = 320;
            for (JsonElement line : lines) width = Math.max(width, number(line.getAsJsonObject(), "width") + 32);
            double height = 58 + lines.size() * 20;
            graphic.apply(new UTranslate(24, noteY)).apply(STROKE).apply(HColorSet.instance().getColorOrWhite("#fffdf5").bg())
                .draw(new URectangle(width, height).rounded(8));
            JsonObject title = new JsonObject(); title.addProperty("text", text(node, "name"));
            label(graphic, title, 40, noteY + 23, font);
            for (int i = 0; i < lines.size(); i++) label(graphic, lines.get(i).getAsJsonObject(), 40, noteY + 46 + i * 20, font);
            noteY += height + 24;
        }
    }

    static String render(JsonObject scene) throws Exception {
        if (scene.getAsJsonArray("nodes").size() > 200 || scene.getAsJsonArray("ports").size() > 1200
                || scene.getAsJsonArray("edges").size() > 800) throw new IllegalArgumentException("SCENE_LIMIT");
        java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
        ImageBuilder.imageBuilder(new FileFormatOption(FileFormat.SVG)).backcolor(WHITE)
            .margin(ClockwiseTopRightBottomLeft.none()).seed(1)
            .drawable(graphic -> draw(graphic, scene)).write(output);
        return output.toString(StandardCharsets.UTF_8).replaceFirst("<svg ", "<svg data-renderer=\"local-layout\" ");
    }

    private static void drawGeneral(UGraphic graphic, JsonObject scene, UFont font) {
        for (JsonElement item : scene.getAsJsonArray("nodes")) {
            JsonObject node = item.getAsJsonObject();
            double x = number(node, "x"), y = number(node, "y"), width = number(node, "width"), height = number(node, "height");
            group(graphic, text(node, "id"));
            graphic.startUrl(new net.sourceforge.plantuml.Url("psysml:" + text(node, "sourceElementId"), text(node, "sourceRef")));
            graphic.apply(new UTranslate(x, y)).apply(STROKE).apply(WHITE.bg()).apply(new UStroke(1.5))
                .draw(new URectangle(width, height).rounded(12));
            graphic.closeUrl();
            for (JsonElement rowElement : node.getAsJsonArray("cardRows")) {
                JsonObject row = rowElement.getAsJsonObject();
                if (row.has("separator") && row.get("separator").getAsBoolean()) {
                    graphic.apply(new UTranslate(x, number(row, "y") - 4)).apply(STROKE).apply(new UStroke(0.8)).draw(new ULine(width, 0));
                }
                graphic.startUrl(new net.sourceforge.plantuml.Url("psysml:" + (row.has("sourceElementId")
                    ? text(row, "sourceElementId") : text(node, "sourceElementId")), text(node, "sourceRef")));
                label(graphic, row, number(row, "x"), number(row, "y") + 15, font);
                graphic.closeUrl();
            }
            graphic.closeGroup();
        }
        for (JsonElement item : scene.getAsJsonArray("edges")) {
            JsonObject edge = item.getAsJsonObject();
            JsonArray points = edge.getAsJsonArray("points");
            UPath path = new UPath();
            for (int i = 0; i < points.size(); i++) {
                JsonObject point = points.get(i).getAsJsonObject();
                if (i == 0) path.moveTo(number(point, "x"), number(point, "y"));
                else path.lineTo(number(point, "x"), number(point, "y"));
            }
            group(graphic, text(edge, "id"));
            graphic.apply(STROKE).apply(edge.get("dashed").getAsBoolean() ? new UStroke(5, 4, 1.5) : new UStroke(1.5)).draw(path);
            String marker = text(edge, "marker");
            if (!marker.equals("none")) {
                JsonObject end = points.get(points.size() - 1).getAsJsonObject(), before = points.get(points.size() - 2).getAsJsonObject();
                double x = number(end, "x"), y = number(end, "y");
                double dx = Math.signum(x - number(before, "x")), dy = Math.signum(y - number(before, "y"));
                UPath arrow = new UPath();
                arrow.moveTo(x - dx * 12 + dy * 5, y - dy * 12 - dx * 5);
                arrow.lineTo(x, y);
                arrow.lineTo(x - dx * 12 - dy * 5, y - dy * 12 + dx * 5);
                if (marker.equals("triangle")) arrow.closePath();
                graphic.apply(STROKE).apply(marker.equals("triangle") ? WHITE.bg() : HColors.none().bg()).apply(new UStroke(1.5)).draw(arrow);
            }
            for (JsonElement row : edge.getAsJsonArray("labels")) {
                JsonObject line = row.getAsJsonObject();
                label(graphic, line, number(line, "x"), number(line, "y") + 15, font);
            }
            graphic.closeGroup();
        }
    }
}
