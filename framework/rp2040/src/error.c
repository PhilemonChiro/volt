#include "volt/error.h"

const char *volt_error_name(volt_error_t error)
{
    switch (error) {
        case VOLT_OK:                      return "VOLT_OK";
        case VOLT_ERR_INVALID_ARG:         return "VOLT_ERR_INVALID_ARG";
        case VOLT_ERR_TIMEOUT:             return "VOLT_ERR_TIMEOUT";
        case VOLT_ERR_NO_MEMORY:           return "VOLT_ERR_NO_MEMORY";
        case VOLT_ERR_NOT_SUPPORTED:       return "VOLT_ERR_NOT_SUPPORTED";
        case VOLT_ERR_INTERNAL:            return "VOLT_ERR_INTERNAL";
        case VOLT_ERR_INVALID_PIN:         return "VOLT_ERR_INVALID_PIN";
        case VOLT_ERR_PIN_IN_USE:          return "VOLT_ERR_PIN_IN_USE";
        case VOLT_ERR_WRONG_PIN_MODE:      return "VOLT_ERR_WRONG_PIN_MODE";
        case VOLT_ERR_PIN_CONFIG_FAILED:   return "VOLT_ERR_PIN_CONFIG_FAILED";
        case VOLT_ERR_TOO_MANY_TASKS:      return "VOLT_ERR_TOO_MANY_TASKS";
        case VOLT_ERR_TASK_CREATE_FAILED:   return "VOLT_ERR_TASK_CREATE_FAILED";
        case VOLT_ERR_TIMER_FAILED:         return "VOLT_ERR_TIMER_FAILED";
        default:                           return "VOLT_ERR_UNKNOWN";
    }
}
