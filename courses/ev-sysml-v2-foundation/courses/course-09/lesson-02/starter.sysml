package EV_C09_L02 {
  private import EV_Program_Baseline::*;
  private import EV_Requirement_Baseline::*;
  private import EV_Analysis_Baseline::*;
  private import VerificationCases::*;

  verification def RangeRoadTest {
    subject testVehicle : ElectricVehicle;
    attribute requiredRangeKm : ScalarValues::Real;
    attribute predictedRangeKm : ScalarValues::Real;
    attribute measuredRangeKm : ScalarValues::Real;
    objective {
      verify vehicleRange;
    }
    @VerificationMethod { kind = VerificationMethodKind::test; }

    action collectData {
      // TODO 1: 添加 measuredRangeKm out 参数，来源为 RangeRoadTest 的观测值
    }

    then action processData {
      // TODO 2: 添加 rawMeasuredRangeKm in 参数绑定和 processedRangeKm out 参数
    }

    then action evaluateData {
      // TODO 3: 添加 processedRangeKm 与 requiredRangeKm 的 in 参数绑定
      // TODO 4: 添加 verdict out 参数，用 PassIf 判定道路实测值
    }

    // TODO 5: 添加 verification return verdict，来源为 evaluateData.verdict
  }

  verification executedRangeRoadTest : RangeRoadTest {
    subject testVehicle = evPrototype;
    attribute :>> requiredRangeKm = vehicleRange.minRangeKm;
    attribute :>> predictedRangeKm = cityRangePrediction.predictedRangeKm;
    attribute :>> measuredRangeKm = rangeRoadTestEvidence.measuredRangeKm;
  }

  view def VerificationExecutionView specializes StandardViewDefinitions::ActionFlowView;
  view verificationExecutionView : VerificationExecutionView {
    expose RangeRoadTest;
    expose executedRangeRoadTest;
    expose vehicleRange;
    expose rangeRoadTestEvidence;
  }
}
