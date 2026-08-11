package EV_C01_L03 {
  // Lesson 02 的完整结构和上下文，保持不变。
  part def BatteryPack;
  part def Driver;
  part def RoadEnvironment;

  part def ElectricVehicle {
    part battery : BatteryPack;
    part driver : Driver;
    part environment : RoadEnvironment;
  }

  part evPrototype : ElectricVehicle;

  // TODO 1: 定义 VehicleNeed 需求类型，并声明 vehicle subject。
  // TODO 2: 创建 usableRange 的 requirement usage，subject 保持开放。
  // TODO 3: 定义 VehicleModelPurpose 分析类型，并声明 vehicle subject。
  // TODO 4: 创建 purposeCheck 的 analysis usage，并绑定 subject。
  // TODO 5: 用 satisfy 连接 usableRange 和 evPrototype。

  view def ContextRequirementView specializes StandardViewDefinitions::GeneralView;
  view contextRequirementView : ContextRequirementView {
    expose ElectricVehicle;
    expose Driver;
    expose RoadEnvironment;
    expose evPrototype;
    // TODO 6: 添加 VehicleNeed 的 expose 视图条目。
    // TODO 7: 添加 usableRange 的 expose 视图条目。
    // TODO 8: 添加 VehicleModelPurpose 的 expose 视图条目。
    // TODO 9: 添加 purposeCheck 的 expose 视图条目。
  }
}
