package EV_C07_L01 {
  private import EV_Program_Baseline::*;

  requirement def RangeAcceptanceRequirement {
    // TODO 1: 添加 doc，说明 480 km 目标和城市工况边界
    // TODO 2: 添加 subject vehicle : ElectricVehicle
    attribute minRangeKm : ScalarValues::Real;
    attribute maxEnergyPer100Km : ScalarValues::Real;
    // TODO 3: 添加 rangeCriterion require constraint，检查报告续航
    // TODO 4: 添加 energyCriterion require constraint，检查百公里能耗
  }

  requirement cityRange : RangeAcceptanceRequirement {
    subject vehicle : ElectricVehicle;
    // TODO 5: 添加两个 attribute 重定义，目标值为 480.0 和 16.0
  }

  // TODO 6: 添加 satisfy cityRange by evPrototype

  view def RequirementAcceptanceView specializes StandardViewDefinitions::GeneralView;
  view requirementAcceptanceView : RequirementAcceptanceView {
    expose RangeAcceptanceRequirement;
    expose cityRange;
    expose evPrototype;
  }
}
