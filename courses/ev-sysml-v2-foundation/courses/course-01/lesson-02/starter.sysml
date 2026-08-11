package EV_C01_L02 {
  // Lesson 01 的结构基线，保持不变。
  part def BatteryPack;

  // TODO 1: 定义 Driver 和 RoadEnvironment 两个外部上下文类型。

  part def ElectricVehicle {
    part battery : BatteryPack;
    // TODO 2: 增加 driver 的 part usage。
    // TODO 3: 增加 environment 的 part usage。
  }

  part evPrototype : ElectricVehicle;

  view def SystemBoundaryView specializes StandardViewDefinitions::GeneralView;
  view systemBoundaryView : SystemBoundaryView {
    expose ElectricVehicle;
    expose evPrototype;
    expose BatteryPack;
  }
}
