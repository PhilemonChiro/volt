#include "volt/error.h"

const char *volt_error_name(volt_error_t error)
{
    switch (error) {
        case VOLT_OK:                     return "OK";
        case VOLT_ERR_INVALID_ARG:        return "INVALID_ARG";
        case VOLT_ERR_TIMEOUT:            return "TIMEOUT";
        case VOLT_ERR_NO_MEMORY:          return "NO_MEMORY";
        case VOLT_ERR_NOT_SUPPORTED:      return "NOT_SUPPORTED";
        case VOLT_ERR_INTERNAL:           return "INTERNAL";
        case VOLT_ERR_INVALID_PIN:        return "INVALID_PIN";
        case VOLT_ERR_PIN_IN_USE:         return "PIN_IN_USE";
        case VOLT_ERR_WRONG_PIN_MODE:     return "WRONG_PIN_MODE";
        case VOLT_ERR_PIN_CONFIG_FAILED:  return "PIN_CONFIG_FAILED";
        case VOLT_ERR_TOO_MANY_TASKS:     return "TOO_MANY_TASKS";
        case VOLT_ERR_TASK_CREATE_FAILED: return "TASK_CREATE_FAILED";
        case VOLT_ERR_TIMER_FAILED:       return "TIMER_FAILED";
        default:                          return "UNKNOWN";
    }
}
