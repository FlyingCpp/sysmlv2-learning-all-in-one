/* 本模型为独立SysML v2教学示例，以Tesla Model 3为参考目标车型。
 * 所有涉及Model 3具体构成与方案的描述均为显式、保守、可逆的建模假设，
 * 不代表逆向工程事实，不包含具体性能数值，不涉及安全关键细节。 */

// ---------- 接口类型定义 ----------
port def CoolantPort;
port def RefrigerantPort;

// ---------- 部件类型定义 ----------
part def CoolantPump {
    doc /* 冷却液泵：驱动冷却液在回路中循环（教学假设）。 */
    port inlet : CoolantPort;
    port outlet : CoolantPort;
}

part def MultiWayValve {
    doc /* 集成多路阀：假设采用类似octovalve的集成阀岛设计（显式假设，可逆）。
     * 用于在电池回路、电驱回路、散热器与chiller之间切换冷却液流向。 */
    port valvePort1 : CoolantPort;
    port valvePort2 : CoolantPort;
    port valvePort3 : CoolantPort;
    port valvePort4 : CoolantPort;
    port valvePort5 : CoolantPort;
}

part def Radiator {
    doc /* 散热器：冷却液与外界空气换热的散热装置（教学假设）。 */
    port coolantInlet : CoolantPort;
    port coolantOutlet : CoolantPort;
}

part def Chiller {
    doc /* Chiller：水-冷媒换热器，连接冷却液回路与冷媒回路（教学假设）。 */
    port coolantInlet : CoolantPort;
    port coolantOutlet : CoolantPort;
    port refrigerantInlet : RefrigerantPort;
    port refrigerantOutlet : RefrigerantPort;
}

part def BatteryCell {
    doc /* 电芯：电池包内最细一级的能量存储单元（教学假设）。
     * 电芯在模组内通过冷却流道间接换热，此处不展开电芯级端口。 */
}

part def CoolingChannel {
    doc /* 冷却流道：模组内冷却液换热通道（教学假设）。
     * 冷却液从模组入口进入流道，与电芯组换热后由模组出口流出（显式假设，可逆）。 */
    port channelInlet : CoolantPort;
    port channelOutlet : CoolantPort;
}

part def BatteryModule {
    doc /* 电池模组：电池包的第一级内部细化单元（教学假设）。
     * 模组内包含电芯组与冷却流道；冷却液由模组级入口进入流道换热后经模组级出口流出。 */
    port coolantInlet : CoolantPort;
    port coolantOutlet : CoolantPort;

    part cellGroup : BatteryCell[24];
    part coolingChannel : CoolingChannel;

    // 模组级内部连接：入口 -> 冷却流道 -> 出口
    connect coolantInlet to coolingChannel.channelInlet;
    connect coolingChannel.channelOutlet to coolantOutlet;
}

part def BatteryPack {
    doc /* 电池包：包含冷却/加热流道，通过冷却液回路实现冷却或预热（教学假设）。
     * 两级内部细化假设（显式、保守、可逆）：
     * 第一级：电池包内由多个串联的电池模组组成，冷却液依次流过各模组；
     * 第二级：每个模组内包含电芯组与冷却流道，冷却液在流道内与电芯组换热。 */
    port coolantInlet : CoolantPort;
    port coolantOutlet : CoolantPort;

    part module1 : BatteryModule;
    part module2 : BatteryModule;
    part module3 : BatteryModule;
    part module4 : BatteryModule;

    // 电池包级内部连接链：外部入口 -> 模组1 -> 模组2 -> 模组3 -> 模组4 -> 外部出口
    connect coolantInlet to module1.coolantInlet;
    connect module1.coolantOutlet to module2.coolantInlet;
    connect module2.coolantOutlet to module3.coolantInlet;
    connect module3.coolantOutlet to module4.coolantInlet;
    connect module4.coolantOutlet to coolantOutlet;
}

part def DriveUnit {
    doc /* 电驱动/动力电子单元：假设包含驱动电机与逆变器，采用液冷（教学假设）。 */
    port coolantInlet : CoolantPort;
    port coolantOutlet : CoolantPort;
}

part def HeatPumpUnit {
    doc /* 热泵单元：假设为蒸汽压缩式热泵，通过冷媒回路传递热量（显式假设）。 */
    port refrigerantInlet : RefrigerantPort;
    port refrigerantOutlet : RefrigerantPort;
}

part def CabinHVACSystem {
    doc /* 座舱热管理：假设采用热泵空调系统；
     * Model 3典型特征是热泵+集成多路阀（显式假设，可逆）。 */
    part heatPump : HeatPumpUnit;
}

// ---------- 系统边界与连接链 ----------
part def ThermalManagementSystem {
    doc /* 系统边界：整车热管理系统。主要子系统包括：
     * 电池热管理回路（电池包及其冷却/加热）、
     * 电驱动/动力电子冷却回路（驱动电机、逆变器等的液冷）、
     * 座舱热管理（热泵空调系统）、
     * 热交换与散热装置（散热器、chiller、冷却液泵、多路阀）。 */

    part batteryPack : BatteryPack;
    part driveUnit : DriveUnit;
    part cabinHVAC : CabinHVACSystem;
    part radiator : Radiator;
    part chiller : Chiller;
    part coolantPump : CoolantPump;
    part multiWayValve : MultiWayValve;

    // 冷却液回路：泵 - 多路阀 - 电池包 / 电机 - 散热器 - 泵
    connect coolantPump.outlet to multiWayValve.valvePort1;
    connect multiWayValve.valvePort2 to batteryPack.coolantInlet;
    connect batteryPack.coolantOutlet to multiWayValve.valvePort3;
    connect multiWayValve.valvePort4 to driveUnit.coolantInlet;
    connect driveUnit.coolantOutlet to radiator.coolantInlet;
    connect radiator.coolantOutlet to coolantPump.inlet;

    // 多路阀切换：冷却液经chiller形成换热支路
    connect multiWayValve.valvePort5 to chiller.coolantInlet;
    connect chiller.coolantOutlet to coolantPump.inlet;

    // 冷媒回路：热泵与chiller之间的冷媒连接
    connect chiller.refrigerantInlet to cabinHVAC.heatPump.refrigerantOutlet;
    connect cabinHVAC.heatPump.refrigerantInlet to chiller.refrigerantOutlet;
}

// ---------- 代表性运行工况：冬季低温（热泵制热 + 电池预热） ----------
action def WinterHeatingMode {
    doc /* 冬季低温工况控制流程（教学假设）：
     * 检测环境温度后切换多路阀流向，
     * 冷却液经chiller与热泵换热以预热电池，
     * 同时热泵向座舱供热。 */
    action checkAmbientTemperature;
    then action regulateValveRouting;
    then action preheatBattery;
    then action heatPumpCabinHeating;
}

// ---------- 具体实例 ----------
part model3ThermalSystem : ThermalManagementSystem;

// ---------- 视图 ----------
view systemOverview : StandardViewDefinitions::GeneralView {
    expose ThermalManagementSystem;
}

view thermalConnections : StandardViewDefinitions::InterconnectionView {
    expose ThermalManagementSystem;
}

view winterHeatingFlow : StandardViewDefinitions::ActionFlowView {
    expose WinterHeatingMode;
}

view batteryPackInternal : StandardViewDefinitions::InterconnectionView {
    expose BatteryPack;
}