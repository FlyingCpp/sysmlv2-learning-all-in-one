package EV_C08_L03 {
  private import EV_Program_Baseline::*;
  private import TradeStudies::*;

  part def RangePackageOption {
    attribute predictedRangeKm : ScalarValues::Real;
    attribute massPenaltyKg : ScalarValues::Real;
    attribute fastChargeMinutes : ScalarValues::Real;
  }

  part standardRangePackage : RangePackageOption {
    attribute :>> predictedRangeKm = 490.0;
    attribute :>> massPenaltyKg = 0.0;
    attribute :>> fastChargeMinutes = 28.0;
  }

  part longRangePackage : RangePackageOption {
    attribute :>> predictedRangeKm = 540.0;
    attribute :>> massPenaltyKg = 90.0;
    attribute :>> fastChargeMinutes = 35.0;
  }

  calc def RangePackageScore {
    in predictedRangeKm : ScalarValues::Real;
    in massPenaltyKg : ScalarValues::Real;
    in fastChargeMinutes : ScalarValues::Real;
    return score : ScalarValues::Real =
      predictedRangeKm - massPenaltyKg - fastChargeMinutes;
  }

  analysis rangePackageTradeStudy : TradeStudy {
    // TODO 1: 添加两个 RangePackageOption alternatives 的 subject 元组
    // TODO 2: 添加 MaximizeObjective objective

    calc :>> evaluationFunction {
      in part option :>> alternative : RangePackageOption;
      // TODO 3: 添加 result return，并调用 RangePackageScore
    }

    // TODO 4: 添加 selectedAlternative part return
  }

  view def RangeTradeStudyView specializes StandardViewDefinitions::GeneralView;
  view rangeTradeStudyView : RangeTradeStudyView {
    expose standardRangePackage;
    expose longRangePackage;
    expose RangePackageScore;
    expose rangePackageTradeStudy;
  }
}
