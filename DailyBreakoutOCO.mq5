//+------------------------------------------------------------------+
//|                                             DailyBreakoutOCO.mq5 |
//|  Strategi:                                                       |
//|   1. Setiap hari baru, semak candle DAILY sebelumnya (shift 1).  |
//|   2. Saiz candle (High - Low, termasuk shadow) mesti >= MinPips. |
//|   3. Pasang BUY STOP di High dan SELL STOP di Low candle tu.     |
//|   4. Bila salah satu trigger, order satu lagi terus dipadam (OCO)|
//|   5. Order yang tak trigger dipadam bila masuk hari baru.        |
//+------------------------------------------------------------------+
#property copyright "Daily Breakout OCO"
#property version   "1.00"
#property description "Buy Stop di High & Sell Stop di Low candle Daily semalam (OCO)"

#include <Trade\Trade.mqh>

//--- Input
input double InpLots           = 0.5;      // Lot size
input double InpMinRangePips   = 800;      // Saiz minimum candle daily (pip)
input int    InpPointsPerPip   = 10;       // 1 pip = berapa point (10 utk XAUUSD 2 digit / forex 5 digit)
input double InpStopLossPips   = 0;        // Stop Loss (pip), 0 = tiada
input double InpTakeProfitPips = 0;        // Take Profit (pip), 0 = tiada
input ulong  InpMagic          = 20261101; // Magic number
input int    InpSlippage       = 30;       // Slippage (point)

//--- Global
CTrade   trade;
datetime g_lastDay   = 0;
datetime g_nextRetry = 0;
string   g_gvName;

//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpSlippage);
   trade.SetTypeFillingBySymbol(_Symbol);

   g_gvName = "DBO_" + _Symbol + "_" + (string)InpMagic;
   if(GlobalVariableCheck(g_gvName))
      g_lastDay = (datetime)GlobalVariableGet(g_gvName);

   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   Comment("");
}

//+------------------------------------------------------------------+
void OnTick()
{
   datetime today = iTime(_Symbol, PERIOD_D1, 0);
   if(today == 0)
      return; // data D1 belum siap

   //--- Hari baru: padam order lama & pasang order baru
   if(today != g_lastDay && TimeCurrent() >= g_nextRetry)
   {
      if(ProcessNewDay(today))
      {
         g_lastDay = today;
         GlobalVariableSet(g_gvName, (double)today);
      }
      else
         g_nextRetry = TimeCurrent() + 10; // cuba lagi selepas 10 saat
   }

   //--- OCO backup (kalau OnTradeTransaction terlepas)
   if(HasPositionOpenedSince(today))
      DeletePendings(0);

   ShowInfo();
}

//+------------------------------------------------------------------+
//| OCO: bila pending kita jadi position, padam pending satu lagi    |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result)
{
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD || trans.symbol != _Symbol)
      return;
   if(!HistoryDealSelect(trans.deal))
      return;
   if((ulong)HistoryDealGetInteger(trans.deal, DEAL_MAGIC) != InpMagic)
      return;
   if(HistoryDealGetInteger(trans.deal, DEAL_ENTRY) != DEAL_ENTRY_IN)
      return;

   Print("Order trigger (deal #", trans.deal, "). Padam pending order yang lain.");
   DeletePendings(0);
}

//+------------------------------------------------------------------+
//| Proses hari baru. Return true = siap (tak perlu cuba lagi)       |
//+------------------------------------------------------------------+
bool ProcessNewDay(datetime today)
{
   //--- 1. Padam pending order dari hari sebelumnya
   DeletePendings(today);

   //--- 2. Kalau hari ni dah ada trade trigger, jangan pasang lagi
   if(HasEntryDealSince(today))
      return(true);

   //--- 3. Ambil candle daily semalam (termasuk shadow)
   double high = iHigh(_Symbol, PERIOD_D1, 1);
   double low  = iLow(_Symbol, PERIOD_D1, 1);
   if(high <= 0 || low <= 0)
      return(false);

   double pip       = _Point * InpPointsPerPip;
   double rangePips = (high - low) / pip;

   if(rangePips < InpMinRangePips)
   {
      PrintFormat("Candle daily semalam = %.1f pip (< %.1f). Tiada order hari ni.",
                  rangePips, InpMinRangePips);
      return(true);
   }

   PrintFormat("Candle daily semalam = %.1f pip. High=%s Low=%s. Pasang order.",
               rangePips, DoubleToString(high, _Digits), DoubleToString(low, _Digits));

   double lots    = NormalizeLots(InpLots);
   double minDist = MathMax((double)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL),
                            (double)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_FREEZE_LEVEL)) * _Point;
   double ask     = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid     = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   string cmt     = "DBO " + TimeToString(today, TIME_DATE);
   bool   ok      = true;

   //--- 4. BUY STOP di High
   if(!HasPending(ORDER_TYPE_BUY_STOP))
   {
      double price = NormalizePrice(high);
      if(ask >= price - minDist)
         Print("Harga dah atas/terlalu dekat High semalam. Buy Stop tidak dipasang.");
      else
      {
         double sl = (InpStopLossPips   > 0) ? NormalizePrice(price - InpStopLossPips   * pip) : 0;
         double tp = (InpTakeProfitPips > 0) ? NormalizePrice(price + InpTakeProfitPips * pip) : 0;
         if(!trade.BuyStop(lots, price, _Symbol, sl, tp, ORDER_TIME_GTC, 0, cmt))
         {
            Print("Gagal pasang Buy Stop: ", trade.ResultRetcode(), " ", trade.ResultRetcodeDescription());
            ok = false;
         }
      }
   }

   //--- 5. SELL STOP di Low
   if(!HasPending(ORDER_TYPE_SELL_STOP))
   {
      double price = NormalizePrice(low);
      if(bid <= price + minDist)
         Print("Harga dah bawah/terlalu dekat Low semalam. Sell Stop tidak dipasang.");
      else
      {
         double sl = (InpStopLossPips   > 0) ? NormalizePrice(price + InpStopLossPips   * pip) : 0;
         double tp = (InpTakeProfitPips > 0) ? NormalizePrice(price - InpTakeProfitPips * pip) : 0;
         if(!trade.SellStop(lots, price, _Symbol, sl, tp, ORDER_TIME_GTC, 0, cmt))
         {
            Print("Gagal pasang Sell Stop: ", trade.ResultRetcode(), " ", trade.ResultRetcodeDescription());
            ok = false;
         }
      }
   }

   return(ok);
}

//+------------------------------------------------------------------+
//| Padam pending order EA ni. before=0 -> padam semua,              |
//| selain tu padam yang dipasang sebelum masa 'before' sahaja       |
//+------------------------------------------------------------------+
void DeletePendings(datetime before)
{
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;
      if(OrderGetString(ORDER_SYMBOL) != _Symbol) continue;
      if((ulong)OrderGetInteger(ORDER_MAGIC) != InpMagic) continue;

      ENUM_ORDER_TYPE type = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      if(type != ORDER_TYPE_BUY_STOP && type != ORDER_TYPE_SELL_STOP) continue;

      if(before != 0 && (datetime)OrderGetInteger(ORDER_TIME_SETUP) >= before) continue;

      if(!trade.OrderDelete(ticket))
         Print("Gagal padam order #", ticket, ": ", trade.ResultRetcodeDescription());
   }
}

//+------------------------------------------------------------------+
bool HasPending(ENUM_ORDER_TYPE type)
{
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;
      if(OrderGetString(ORDER_SYMBOL) != _Symbol) continue;
      if((ulong)OrderGetInteger(ORDER_MAGIC) != InpMagic) continue;
      if((ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE) == type)
         return(true);
   }
   return(false);
}

//+------------------------------------------------------------------+
bool HasPositionOpenedSince(datetime since)
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
      if((ulong)PositionGetInteger(POSITION_MAGIC) != InpMagic) continue;
      if((datetime)PositionGetInteger(POSITION_TIME) >= since)
         return(true);
   }
   return(false);
}

//+------------------------------------------------------------------+
//| Ada tak trade (entry) EA ni sejak 'since' (termasuk yg dah close)|
//+------------------------------------------------------------------+
bool HasEntryDealSince(datetime since)
{
   if(HasPositionOpenedSince(since))
      return(true);

   if(!HistorySelect(since, TimeCurrent() + 86400))
      return(false);

   for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
   {
      ulong deal = HistoryDealGetTicket(i);
      if(deal == 0) continue;
      if(HistoryDealGetString(deal, DEAL_SYMBOL) != _Symbol) continue;
      if((ulong)HistoryDealGetInteger(deal, DEAL_MAGIC) != InpMagic) continue;
      if(HistoryDealGetInteger(deal, DEAL_ENTRY) == DEAL_ENTRY_IN)
         return(true);
   }
   return(false);
}

//+------------------------------------------------------------------+
double NormalizePrice(double price)
{
   double tick = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tick > 0)
      price = MathRound(price / tick) * tick;
   return(NormalizeDouble(price, _Digits));
}

//+------------------------------------------------------------------+
double NormalizeLots(double lots)
{
   double minLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double stepLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(stepLot > 0)
      lots = MathFloor(lots / stepLot + 1e-9) * stepLot;
   lots = MathMax(minLot, MathMin(maxLot, lots));
   return(NormalizeDouble(lots, 2));
}

//+------------------------------------------------------------------+
void ShowInfo()
{
   double high = iHigh(_Symbol, PERIOD_D1, 1);
   double low  = iLow(_Symbol, PERIOD_D1, 1);
   double rangePips = (high - low) / (_Point * InpPointsPerPip);

   Comment(StringFormat("Daily Breakout OCO\n"
                        "High semalam : %s\n"
                        "Low semalam  : %s\n"
                        "Saiz candle  : %.1f pip (min %.1f)\n"
                        "Status       : %s",
                        DoubleToString(high, _Digits),
                        DoubleToString(low, _Digits),
                        rangePips, InpMinRangePips,
                        rangePips >= InpMinRangePips ? "LAYAK" : "TAK LAYAK"));
}
//+------------------------------------------------------------------+
